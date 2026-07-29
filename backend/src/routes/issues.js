const express = require('express');
const pool = require('../db');
const { requireAuth, requirePasswordReady } = require('../auth');
const { publicUrlFor, presignGetUrl } = require('../spaces');
const { logAudit } = require('../audit');
const { notifyUsers, allMaintenanceUsers, ceoUsers } = require('../notifications');

const router = express.Router();
router.use(requireAuth);
router.use(requirePasswordReady);

function genId() {
  return 'ISS-' + Date.now().toString(36).toUpperCase() + Math.floor(Math.random() * 90 + 10);
}

async function insertMedia(issueId, list, phase) {
  if (!Array.isArray(list)) return;
  for (const m of list) {
    if (!m || !m.key || !m.type) continue;
    await pool.query(
      `INSERT INTO issue_media (issue_id, phase, media_type, spaces_key, url) VALUES ($1,$2,$3,$4,$5)`,
      [issueId, phase, m.type, m.key, publicUrlFor(m.key)]
    );
  }
}

function canReadAll(user) {
  return ['admin', 'ceo'].includes(user.role) || (user.role === 'coordinator' && user.isHead);
}

function readScope(user) {
  if (canReadAll(user)) return { sql: '', params: [] };
  if (user.role === 'coordinator') return { sql: 'WHERE branch_code = ANY($1)', params: [user.routes || []] };
  return { sql: 'WHERE branch_code = $1', params: [user.branch] };
}

async function mediaForClient(media) {
  const privateMedia = process.env.MEDIA_PUBLIC_READ !== 'true';
  if (!privateMedia) return media;
  return Promise.all(media.map(async m => ({
    ...m,
    url: await presignGetUrl(m.spaces_key)
  })));
}

function approvalThreshold() {
  return Number(process.env.CEO_APPROVAL_THRESHOLD || 300000);
}

// GET /api/issues  -> scoped by role. Admin/CEO/head see all; branch users see their queue.
router.get('/', async (req, res) => {
  try {
    const scope = readScope(req.user);
    const { rows: issues } = await pool.query(`SELECT * FROM issues ${scope.sql} ORDER BY opened_at DESC`, scope.params);
    const ids = issues.map(i => i.id);
    let mediaByIssue = {};
    if (ids.length) {
      const { rows: media } = await pool.query('SELECT * FROM issue_media WHERE issue_id = ANY($1)', [ids]);
      const clientMedia = await mediaForClient(media);
      clientMedia.forEach(m => { (mediaByIssue[m.issue_id] ||= []).push(m); });
    }
    res.json(issues.map(i => ({ ...i, media: mediaByIssue[i.id] || [] })));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Could not load issues' });
  }
});

// POST /api/issues  -> captain or reporter opens a new (or backdated/old) issue
router.post('/', async (req, res) => {
  const u = req.user;
  if (!['captain', 'reporter'].includes(u.role)) return res.status(403).json({ error: 'Not allowed' });

  const {
    title, category, description, openProof, openedAt, isOld, openMedia,
    estimatedCost, approvalRequired,
    statusOverride, verifiedByName, verifiedAt, auditorNote,
    closedByName, closedAt, closeProof, closeMedia
  } = req.body || {};

  if (!title || !description) return res.status(400).json({ error: 'Title and description required' });

  const id = genId();
  let status = 'open';
  let vName = null, vAt = null, vNote = null;
  let cName = null, cAt = null, cNote = null;
  const cost = Number(estimatedCost || 0);
  const needsApproval = !!approvalRequired || cost >= approvalThreshold();
  const approvalStatus = needsApproval ? 'pending' : 'not_required';
  const approvalRequestedAt = needsApproval ? new Date().toISOString() : null;

  if (u.role === 'reporter') {
    // No local auditor for this location — route straight to the maintenance team head.
    status = 'verified';
    vName = 'Routed automatically \u2014 no auditor assigned';
    vAt = openedAt || new Date().toISOString();
    vNote = 'No local maintenance team; routed directly to the Head of Maintenance Department.';
  } else if (isOld && (statusOverride === 'verified' || statusOverride === 'closed')) {
    status = 'verified';
    vName = verifiedByName || 'Branch auditor';
    vAt = verifiedAt || new Date().toISOString();
    vNote = auditorNote || null;
    if (statusOverride === 'closed') {
      status = 'closed';
      cName = closedByName || 'Maintenance team';
      cAt = closedAt || new Date().toISOString();
      cNote = closeProof || null;
    }
  }

  try {
    await pool.query(
      `INSERT INTO issues
         (id, branch_code, title, category, description, status, is_old, open_proof,
          opened_by, opened_by_name, opened_at, verified_by_name, verified_at, auditor_note,
          closed_by_name, closed_at, close_proof, estimated_cost, approval_required,
          approval_status, approval_requested_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)`,
      [id, u.branch, title, category, description, status, !!isOld, openProof || null,
        u.id, u.name, openedAt || new Date().toISOString(), vName, vAt, vNote, cName, cAt, cNote,
        cost || null, needsApproval, approvalStatus, approvalRequestedAt]
    );
    await insertMedia(id, openMedia, 'open');
    await insertMedia(id, closeMedia, 'close');
    await logAudit(u, 'issue_created', 'issue', id, { branch: u.branch, status, estimatedCost: cost || null, approvalStatus });
    await notifyUsers(
      await allMaintenanceUsers(),
      id,
      'issue_created',
      `MAXBACHAT: New issue ${id} at ${u.branch}. ${title}`
    );
    if (status === 'verified') {
      await notifyUsers(
        await allMaintenanceUsers(),
        id,
        'issue_verified',
        `MAXBACHAT: Issue ${id} is ready for maintenance action at ${u.branch}. ${title}`
      );
    }
    if (needsApproval) {
      await notifyUsers(
        await ceoUsers(),
        id,
        'approval_requested',
        `CEO approval needed for issue ${id}. Estimated cost: ${cost || 'not provided'}. ${title}`
      );
    }
    res.json({ id });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Could not save issue' });
  }
});

// POST /api/issues/:id/verify  -> auditor verifies an open issue in their own branch
router.post('/:id/verify', async (req, res) => {
  const u = req.user;
  if (u.role !== 'auditor') return res.status(403).json({ error: 'Not allowed' });
  const { note } = req.body || {};
  try {
    const { rowCount } = await pool.query(
      `UPDATE issues SET status='verified', verified_by=$1, verified_by_name=$2, verified_at=now(), auditor_note=$3
       WHERE id=$4 AND branch_code=$5 AND status='open'`,
      [u.id, u.name, note || null, req.params.id, u.branch]
    );
    if (!rowCount) return res.status(404).json({ error: 'Issue not found or already verified' });
    await logAudit(u, 'issue_verified', 'issue', req.params.id, { branch: u.branch });
    const issue = await pool.query('SELECT title, branch_code, approval_status FROM issues WHERE id=$1', [req.params.id]);
    if (issue.rows[0]) {
      await notifyUsers(
        await allMaintenanceUsers(),
        req.params.id,
        'issue_verified',
        `MAXBACHAT: Issue ${req.params.id} verified at ${issue.rows[0].branch_code}. ${issue.rows[0].title}`
      );
      if (issue.rows[0].approval_status === 'pending') {
        await notifyUsers(
          await ceoUsers(),
          req.params.id,
          'approval_requested',
          `CEO approval pending for verified issue ${req.params.id}: ${issue.rows[0].title}`
        );
      }
    }
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Could not verify issue' });
  }
});

// POST /api/issues/:id/close  -> maintenance team resolves a verified issue, with proof
router.post('/:id/close', async (req, res) => {
  const u = req.user;
  if (u.role !== 'coordinator') return res.status(403).json({ error: 'Not allowed' });
  const { note, media } = req.body || {};

  try {
    const { rows } = await pool.query('SELECT branch_code, status, approval_status FROM issues WHERE id=$1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Issue not found' });
    if (!u.routes.includes(rows[0].branch_code)) return res.status(403).json({ error: 'This issue is not in your queue' });
    if (rows[0].status !== 'verified') return res.status(400).json({ error: 'Issue must be verified before it can be resolved' });
    if (rows[0].approval_status === 'pending') return res.status(403).json({ error: 'CEO approval is pending for this issue' });
    if (rows[0].approval_status === 'rejected') return res.status(403).json({ error: 'CEO rejected this repair approval' });

    await pool.query(
      `UPDATE issues SET status='closed', closed_by=$1, closed_by_name=$2, closed_at=now(), close_proof=$3
       WHERE id=$4`,
      [u.id, u.name, note || null, req.params.id]
    );
    await insertMedia(req.params.id, media, 'close');
    await logAudit(u, 'issue_closed', 'issue', req.params.id, { branch: rows[0].branch_code });
    await notifyUsers(
      await allMaintenanceUsers(),
      req.params.id,
      'issue_closed',
      `MAXBACHAT: Issue ${req.params.id} has been marked resolved at ${rows[0].branch_code}.`
    );
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Could not resolve issue' });
  }
});

router.post('/:id/approval', async (req, res) => {
  const u = req.user;
  if (u.role !== 'ceo' && u.role !== 'admin') return res.status(403).json({ error: 'CEO approval access required' });
  const { decision, note } = req.body || {};
  if (!['approved', 'rejected'].includes(decision)) return res.status(400).json({ error: 'Decision must be approved or rejected' });

  try {
    const { rows } = await pool.query('SELECT branch_code, title, approval_status FROM issues WHERE id=$1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Issue not found' });
    if (rows[0].approval_status !== 'pending') return res.status(400).json({ error: 'Issue is not pending approval' });

    await pool.query(
      `UPDATE issues SET approval_status=$1, approved_by=$2, approved_by_name=$3, approved_at=now(), approval_note=$4
       WHERE id=$5`,
      [decision, u.id, u.name, note || null, req.params.id]
    );
    await logAudit(u, `issue_${decision}`, 'issue', req.params.id, { note: note || null });
    await notifyUsers(
      await allMaintenanceUsers(),
      req.params.id,
      `approval_${decision}`,
      `MAXBACHAT: CEO approval ${decision} for issue ${req.params.id}. ${rows[0].title}`
    );
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Could not save approval decision' });
  }
});

module.exports = router;

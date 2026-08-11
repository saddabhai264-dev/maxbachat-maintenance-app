const express = require('express');
const pool = require('../db');
const { requireAuth, requirePasswordReady } = require('../auth');
const { publicUrlFor, presignGetUrl } = require('../spaces');
const { logAudit } = require('../audit');
const { notifyUsers, coordinatorsForBranch, forcedMaintenanceRecipients, forceNotifyMaintenance } = require('../notifications');

const router = express.Router();
router.use(requireAuth);
router.use(requirePasswordReady);

const BRANCH_NAMES = {
  BR1: 'Thandi Sarak',
  BR2: 'Qasimabad',
  BR3: 'MPK',
  BR4: 'Latifabad',
  JDC: 'JDC Warehouse',
  MANDI: 'Mandi'
};

function genId() {
  return 'ISS-' + Date.now().toString(36).toUpperCase() + Math.floor(Math.random() * 90 + 10);
}

async function insertMedia(issueId, list, phase) {
  if (!Array.isArray(list)) return;
  for (const m of list) {
    if (!m || !m.type || (!m.key && !m.url)) continue;
    const key = m.key || `inline/${Date.now()}`;
    const url = m.url || publicUrlFor(key);
    await pool.query(
      `INSERT INTO issue_media (issue_id, phase, media_type, spaces_key, url) VALUES ($1,$2,$3,$4,$5)`,
      [issueId, phase, m.type, key, url]
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
    url: m.spaces_key && m.spaces_key.startsWith('inline/') ? m.url : await presignGetUrl(m.spaces_key)
  })));
}

function canFinalReview(user, issue) {
  return user.role === 'admin';
}

function canReadIssue(user, issue) {
  return canReadAll(user) ||
    (user.role === 'coordinator' && (user.routes || []).includes(issue.branch_code)) ||
    (user.branch && user.branch === issue.branch_code);
}

async function adminReviewers() {
  const { rows } = await pool.query(
    `SELECT id, name, phone, role FROM users WHERE is_active=true AND role='admin'`
  );
  return rows;
}

// GET /api/issues  -> scoped by role. Admin/CEO/head see all; branch users see their queue.
router.get('/', async (req, res) => {
  try {
    const includeMedia = req.query.media === '1' || req.query.media === 'true';
    const scope = readScope(req.user);
    const { rows: issues } = await pool.query(`SELECT * FROM issues ${scope.sql} ORDER BY opened_at DESC`, scope.params);
    if (!includeMedia) return res.json(issues.map(i => ({ ...i, media: [] })));

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

// GET /api/issues/:id/media -> load proof photos/videos for one issue on demand.
router.get('/:id/media', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT id, branch_code FROM issues WHERE id=$1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Issue not found' });
    const issue = rows[0];
    if (!canReadIssue(req.user, issue)) return res.status(403).json({ error: 'Not allowed' });

    const media = await pool.query(
      'SELECT * FROM issue_media WHERE issue_id=$1 ORDER BY uploaded_at ASC',
      [req.params.id]
    );
    res.json(await mediaForClient(media.rows));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Could not load proof media' });
  }
});

router.get('/:id/timeline', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM issues WHERE id=$1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Issue not found' });
    const issue = rows[0];
    if (!canReadIssue(req.user, issue)) return res.status(403).json({ error: 'Not allowed' });

    const synthetic = [
      { action: 'created', actor_name: issue.opened_by_name, created_at: issue.opened_at, details: { status: 'open' } },
      issue.verified_at ? { action: 'verified', actor_name: issue.verified_by_name, created_at: issue.verified_at, details: { note: issue.auditor_note } } : null,
      issue.assigned_at ? { action: 'assigned', actor_name: issue.assigned_by_name, created_at: issue.assigned_at, details: { assignedTo: issue.assigned_to_name, note: issue.assignment_note } } : null,
      issue.resolved_at ? { action: 'submitted_for_final_ok', actor_name: issue.resolved_by_name, created_at: issue.resolved_at, details: { proof: issue.close_proof } } : null,
      issue.final_verified_at ? { action: 'admin_final_ok', actor_name: issue.final_verified_by_name, created_at: issue.final_verified_at, details: { score: issue.final_score, note: issue.final_verify_note } } : null
    ].filter(Boolean);
    const audit = await pool.query(
      `SELECT action, actor_name, created_at, details
       FROM audit_logs
       WHERE target_type='issue' AND target_id=$1
       ORDER BY created_at ASC`,
      [req.params.id]
    );
    res.json([...synthetic, ...audit.rows].sort((a, b) => new Date(a.created_at) - new Date(b.created_at)));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Could not load timeline' });
  }
});

router.post('/:id/assign', async (req, res) => {
  const u = req.user;
  if (u.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });
  const { userId, note } = req.body || {};
  if (!userId) return res.status(400).json({ error: 'Assigned user is required' });

  try {
    const issueResult = await pool.query('SELECT id, branch_code, status, title FROM issues WHERE id=$1', [req.params.id]);
    if (!issueResult.rows.length) return res.status(404).json({ error: 'Issue not found' });
    const issue = issueResult.rows[0];
    if (issue.status === 'closed') return res.status(400).json({ error: 'Closed issue cannot be assigned' });

    const userResult = await pool.query(
      `SELECT u.id, u.name, u.phone, u.role
       FROM users u
       JOIN user_routes r ON r.user_id=u.id
       WHERE u.id=$1 AND u.role='coordinator' AND u.is_active=true AND r.branch_code=$2`,
      [String(userId).toUpperCase(), issue.branch_code]
    );
    if (!userResult.rows.length) return res.status(400).json({ error: 'Selected user is not responsible for this branch' });
    const assignee = userResult.rows[0];

    await pool.query(
      `UPDATE issues
       SET assigned_to=$1, assigned_to_name=$2, assigned_by=$3, assigned_by_name=$4, assigned_at=now(), assignment_note=$5
       WHERE id=$6`,
      [assignee.id, assignee.name, u.id, u.name, note || null, req.params.id]
    );
    await logAudit(u, 'issue_assigned', 'issue', req.params.id, {
      branch: issue.branch_code,
      assignedTo: assignee.id,
      note: note || null
    });
    await notifyUsers(
      [assignee],
      req.params.id,
      'issue_assigned',
      `MAXBACHAT: Issue ${req.params.id} at ${issue.branch_code} assigned to you. ${issue.title}`
    );
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Could not assign issue' });
  }
});

// POST /api/issues  -> captain or reporter opens a new (or backdated/old) issue
router.post('/', async (req, res) => {
  const u = req.user;
  if (!['captain', 'reporter'].includes(u.role)) return res.status(403).json({ error: 'Not allowed' });

  const {
    title, category, description, openProof, openedAt, isOld, openMedia,
    statusOverride, verifiedByName, verifiedAt, auditorNote,
    closedByName, closedAt, closeProof, closeMedia
  } = req.body || {};

  if (!title || !description) return res.status(400).json({ error: 'Title and description required' });

  const id = genId();
  let status = 'open';
  let vName = null, vAt = null, vNote = null;
  let cName = null, cAt = null, cNote = null;
  const approvalStatus = 'not_required';

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
          closed_by_name, closed_at, close_proof, approval_required,
          approval_status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
      [id, u.branch, title, category, description, status, !!isOld, openProof || null,
        u.id, u.name, openedAt || new Date().toISOString(), vName, vAt, vNote, cName, cAt, cNote,
        false, approvalStatus]
    );
    await insertMedia(id, openMedia, 'open');
    await insertMedia(id, closeMedia, 'close');
    await logAudit(u, 'issue_created', 'issue', id, { branch: u.branch, status });
    const forcedRecipients = await forceNotifyMaintenance(
      { id, branchCode: u.branch, branchName: BRANCH_NAMES[u.branch], title, category },
      u
    );
    await logAudit(u, 'force_notification_sent', 'issue', id, {
      branch: u.branch,
      recipients: forcedRecipients.map(r => r.id)
    });
    res.json({ id });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Could not save issue' });
  }
});

// DELETE /api/issues/:id -> captain/reporter can remove their own open issue before it is verified.
router.delete('/:id', async (req, res) => {
  const u = req.user;
  if (!['captain', 'reporter', 'admin'].includes(u.role)) return res.status(403).json({ error: 'Not allowed' });

  try {
    const { rows } = await pool.query('SELECT id, branch_code, status, opened_by, title FROM issues WHERE id=$1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Issue not found' });

    const issue = rows[0];
    const isAdmin = u.role === 'admin';
    const ownsOpenIssue = issue.status === 'open' && issue.opened_by === u.id && issue.branch_code === u.branch;
    if (!isAdmin && !ownsOpenIssue) {
      return res.status(403).json({ error: 'Only your own open issue can be deleted' });
    }

    await pool.query('DELETE FROM issues WHERE id=$1', [req.params.id]);
    await logAudit(u, 'issue_deleted', 'issue', req.params.id, {
      branch: issue.branch_code,
      title: issue.title,
      status: issue.status
    });
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Could not delete issue' });
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
        await forcedMaintenanceRecipients(issue.rows[0].branch_code),
        req.params.id,
        'issue_verified',
        `MAXBACHAT: Issue ${req.params.id} verified at ${issue.rows[0].branch_code}. ${issue.rows[0].title}`
      );
    }
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Could not verify issue' });
  }
});

// POST /api/issues/:id/close -> maintenance team submits resolution for final verification
router.post('/:id/close', async (req, res) => {
  const u = req.user;
  if (u.role !== 'coordinator') return res.status(403).json({ error: 'Not allowed' });
  const { note, media } = req.body || {};

  try {
    const { rows } = await pool.query('SELECT branch_code, status, title, assigned_to FROM issues WHERE id=$1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Issue not found' });
    if (!u.routes.includes(rows[0].branch_code)) return res.status(403).json({ error: 'This issue is not in your queue' });
    if (rows[0].assigned_to && rows[0].assigned_to !== u.id && !u.isHead) {
      return res.status(403).json({ error: 'This issue is assigned to another maintenance user' });
    }
    if (rows[0].status !== 'verified') return res.status(400).json({ error: 'Issue must be verified before it can be resolved' });
    await pool.query(
      `UPDATE issues SET status='pending_review', resolved_by=$1, resolved_by_name=$2, resolved_at=now(), close_proof=$3
       WHERE id=$4`,
      [u.id, u.name, note || null, req.params.id]
    );
    await insertMedia(req.params.id, media, 'close');
    await logAudit(u, 'issue_resolution_submitted', 'issue', req.params.id, { branch: rows[0].branch_code });
    await notifyUsers(
      await adminReviewers(),
      req.params.id,
      'issue_resolution_submitted',
      `MAXBACHAT: Issue ${req.params.id} at ${rows[0].branch_code} was submitted as resolved. Admin final OK required. ${rows[0].title}`
    );
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Could not resolve issue' });
  }
});

router.post('/:id/final-verify', async (req, res) => {
  const u = req.user;
  const { note, score } = req.body || {};
  const finalScore = score === undefined || score === null || score === '' ? 5 : Number(score);
  if (!Number.isInteger(finalScore) || finalScore < 1 || finalScore > 5) {
    return res.status(400).json({ error: 'Final score must be between 1 and 5' });
  }

  try {
    const { rows } = await pool.query('SELECT branch_code, status, title FROM issues WHERE id=$1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Issue not found' });
    const issue = rows[0];
    if (!canFinalReview(u, issue)) return res.status(403).json({ error: 'Not allowed' });
    if (issue.status !== 'pending_review') {
      return res.status(400).json({ error: 'Issue is not awaiting final verification' });
    }

    await pool.query(
      `UPDATE issues
       SET status='closed', closed_by=$1, closed_by_name=$2, closed_at=now(),
           final_verified_by=$1, final_verified_by_name=$2, final_verified_at=now(), final_verify_note=$3,
           final_score=$4
       WHERE id=$5`,
      [u.id, u.name, note || null, finalScore, req.params.id]
    );
    await logAudit(u, 'issue_final_verified', 'issue', req.params.id, { branch: issue.branch_code, score: finalScore });
    await notifyUsers(
      await forcedMaintenanceRecipients(issue.branch_code),
      req.params.id,
      'issue_final_verified',
      `MAXBACHAT: Issue ${req.params.id} at ${issue.branch_code} has been finally verified and closed. ${issue.title}`
    );
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Could not final verify issue' });
  }
});

router.post('/:id/reject-resolution', async (req, res) => {
  const u = req.user;
  const { note } = req.body || {};
  if (!note || !note.trim()) return res.status(400).json({ error: 'Rejection note is required' });

  try {
    const { rows } = await pool.query('SELECT branch_code, status, title, auditor_note FROM issues WHERE id=$1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Issue not found' });
    const issue = rows[0];
    if (!canFinalReview(u, issue)) return res.status(403).json({ error: 'Not allowed' });
    if (issue.status !== 'pending_review') {
      return res.status(400).json({ error: 'Issue is not awaiting final verification' });
    }

    const rejectionNote = [
      issue.auditor_note,
      `Resolution rejected by ${u.name}: ${note.trim()}`
    ].filter(Boolean).join('\n');
    await pool.query(
      `UPDATE issues
       SET status='verified', auditor_note=$1, final_verify_note=$2, rejection_count=coalesce(rejection_count,0)+1
       WHERE id=$3`,
      [rejectionNote, note.trim(), req.params.id]
    );
    await logAudit(u, 'issue_resolution_rejected', 'issue', req.params.id, { branch: issue.branch_code });
    await notifyUsers(
      await forcedMaintenanceRecipients(issue.branch_code),
      req.params.id,
      'issue_resolution_rejected',
      `MAXBACHAT: Issue ${req.params.id} at ${issue.branch_code} was not approved. Reason: ${note.trim()}`
    );
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Could not reject resolution' });
  }
});

module.exports = router;

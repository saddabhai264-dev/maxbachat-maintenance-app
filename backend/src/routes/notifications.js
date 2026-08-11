const express = require('express');
const pool = require('../db');
const { requireAuth, requirePasswordReady } = require('../auth');
const { logAudit } = require('../audit');
const { notifyUsers, forcedMaintenanceRecipients, maintenanceHeadUsers } = require('../notifications');

const router = express.Router();

function hoursForIssue(issue) {
  const category = String(issue.category || '').toLowerCase();
  if (category.includes('refrigeration') || category.includes('cold')) return 2;
  if (category.includes('electrical')) return 4;
  if (category.includes('plumbing')) return 6;
  if (category.includes('cleanliness')) return 8;
  return Number(process.env.DEFAULT_ISSUE_SLA_HOURS || 24);
}

function minutesBetween(a, b) {
  return Math.floor((new Date(a).getTime() - new Date(b).getTime()) / 60000);
}

async function adminUsers() {
  const { rows } = await pool.query(
    `SELECT id, name, phone, role FROM users WHERE is_active=true AND role='admin'`
  );
  return rows;
}

async function recipientsForIssue(issue, stage) {
  if (stage === 'pending_review') return adminUsers();
  if (stage === 'escalation') {
    const admins = await adminUsers();
    const heads = await maintenanceHeadUsers();
    return [...heads, ...admins].filter((u, index, list) => (
      u && u.id && list.findIndex(x => x.id === u.id) === index
    ));
  }
  if (issue.assigned_to) {
    const assigned = await pool.query(
      `SELECT id, name, phone, role FROM users WHERE is_active=true AND id=$1`,
      [issue.assigned_to]
    );
    return assigned.rows;
  }
  return forcedMaintenanceRecipients(issue.branch_code);
}

async function runReminderEngine(actor) {
  const { rows: issues } = await pool.query(
    `SELECT id, branch_code, title, category, status, opened_at, verified_at, resolved_at, assigned_to
     FROM issues
     WHERE status IN ('verified','pending_review')
     ORDER BY opened_at ASC
     LIMIT 200`
  );

  let notifications = 0;
  const now = new Date();
  for (const issue of issues) {
    const baseAt = issue.status === 'pending_review'
      ? (issue.resolved_at || issue.verified_at || issue.opened_at)
      : (issue.verified_at || issue.opened_at);
    const slaHours = issue.status === 'pending_review' ? 12 : hoursForIssue(issue);
    const dueAt = new Date(new Date(baseAt).getTime() + slaHours * 60 * 60000);
    const dueSoonAt = new Date(dueAt.getTime() - 60 * 60000);
    const escalationAt = new Date(dueAt.getTime() + Number(process.env.ESCALATION_AFTER_HOURS || 4) * 60 * 60000);

    const stages = [];
    if (now >= dueSoonAt && now < dueAt) stages.push('due_soon');
    if (now >= dueAt) stages.push('overdue');
    if (now >= escalationAt) stages.push('escalation');

    for (const stage of stages) {
      const recipients = await recipientsForIssue(issue, stage === 'escalation' ? 'escalation' : issue.status);
      if (!recipients.length) continue;
      const minutes = Math.abs(minutesBetween(stage === 'due_soon' ? dueAt : now, now));
      const title = stage === 'due_soon' ? 'Issue due soon' : stage === 'overdue' ? 'Overdue issue' : 'Escalation alert';
      const message = stage === 'due_soon'
        ? `MAXBACHAT: ${issue.title} (${issue.branch_code}) is due in about ${Math.max(1, minutes)} minutes.`
        : stage === 'overdue'
          ? `MAXBACHAT: ${issue.title} (${issue.branch_code}) is overdue. Please update the app.`
          : `MAXBACHAT ESCALATION: ${issue.title} (${issue.branch_code}) is still overdue.`;
      await notifyUsers(recipients, issue.id, stage, message, {
        title,
        priority: stage === 'due_soon' ? 'high' : 'critical',
        reminderKey: `${issue.id}:${stage}`
      });
      notifications += recipients.length;
    }
  }

  if (actor) {
    await logAudit(actor, 'automatic_reminders_checked', 'notification', null, {
      issues: issues.length,
      notifications
    });
  }
  return { ok: true, issues: issues.length, notifications };
}

router.all('/run-reminders', async (req, res) => {
  if (!process.env.CRON_SECRET || req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Cron secret required' });
  }
  try {
    res.json(await runReminderEngine(null));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Could not run reminder engine' });
  }
});

router.use(requireAuth);
router.use(requirePasswordReady);

router.get('/mine', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, issue_id, user_id, phone, event_type, title, message, priority, action_url, is_read, read_at, status, error, created_at
       FROM notification_logs
       WHERE user_id=$1
       ORDER BY created_at DESC
       LIMIT 80`,
      [req.user.id]
    );
    res.json(rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Could not load notifications' });
  }
});

router.get('/admin', async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });
  try {
    const { rows } = await pool.query(
      `SELECT id, issue_id, user_id, phone, event_type, title, message, priority, action_url, is_read, read_at, status, error, created_at
       FROM notification_logs
       ORDER BY created_at DESC
       LIMIT 200`
    );
    res.json(rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Could not load notifications' });
  }
});

router.post('/:id/read', async (req, res) => {
  try {
    const { rowCount } = await pool.query(
      `UPDATE notification_logs SET is_read=true, read_at=now()
       WHERE id=$1 AND user_id=$2`,
      [req.params.id, req.user.id]
    );
    if (!rowCount) return res.status(404).json({ error: 'Notification not found' });
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Could not mark notification read' });
  }
});

router.post('/read-all', async (req, res) => {
  try {
    await pool.query(
      `UPDATE notification_logs SET is_read=true, read_at=now()
       WHERE user_id=$1 AND is_read=false`,
      [req.user.id]
    );
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Could not mark notifications read' });
  }
});

router.get('/settings', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `INSERT INTO notification_settings (user_id) VALUES ($1)
       ON CONFLICT (user_id) DO NOTHING
       RETURNING *`,
      [req.user.id]
    );
    if (rows.length) return res.json(rows[0]);
    const existing = await pool.query('SELECT * FROM notification_settings WHERE user_id=$1', [req.user.id]);
    res.json(existing.rows[0]);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Could not load notification settings' });
  }
});

router.post('/settings', async (req, res) => {
  const allowed = ['browser_enabled', 'issue_assigned', 'due_soon', 'overdue', 'resolution_updates', 'escalation_alerts'];
  const values = {};
  for (const key of allowed) {
    if (Object.prototype.hasOwnProperty.call(req.body || {}, key)) values[key] = !!req.body[key];
  }
  if (req.user.role === 'admin') values.escalation_alerts = true;
  if (req.user.role === 'coordinator') values.overdue = true;

  try {
    await pool.query('INSERT INTO notification_settings (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING', [req.user.id]);
    for (const [key, value] of Object.entries(values)) {
      await pool.query(`UPDATE notification_settings SET ${key}=$1, updated_at=now() WHERE user_id=$2`, [value, req.user.id]);
    }
    const { rows } = await pool.query('SELECT * FROM notification_settings WHERE user_id=$1', [req.user.id]);
    res.json(rows[0]);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Could not save notification settings' });
  }
});

router.post('/automatic-reminders', async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });
  try {
    res.json(await runReminderEngine(req.user));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Could not run reminder engine' });
  }
});

router.post('/reminders', async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });

  try {
    const { rows: issues } = await pool.query(
      `SELECT id, branch_code, title, status, assigned_to
       FROM issues
       WHERE status IN ('verified','pending_review')
       ORDER BY opened_at ASC
       LIMIT 50`
    );
    let sentTo = 0;
    for (const issue of issues) {
      let users = [];
      if (issue.assigned_to) {
        const assigned = await pool.query(
          `SELECT id, name, phone, role FROM users WHERE is_active=true AND id=$1`,
          [issue.assigned_to]
        );
        users = assigned.rows;
      } else {
        users = await forcedMaintenanceRecipients(issue.branch_code);
      }
      const message = [
        'MAXBACHAT MAINTENANCE REMINDER',
        `Issue: ${issue.id}`,
        `Branch: ${issue.branch_code}`,
        `Status: ${issue.status === 'pending_review' ? 'Waiting admin final OK' : 'Pending maintenance action'}`,
        `Title: ${issue.title}`,
        'Please update the maintenance app.'
      ].join('\n');
      await notifyUsers(users, issue.id, 'manual_reminder', message);
      sentTo += users.length;
    }
    await logAudit(req.user, 'manual_reminders_sent', 'notification', null, {
      issues: issues.length,
      recipients: sentTo
    });
    res.json({ ok: true, issues: issues.length, recipients: sentTo });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Could not send reminders' });
  }
});

module.exports = router;

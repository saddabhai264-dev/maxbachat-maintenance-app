const express = require('express');
const pool = require('../db');
const { requireAuth, requirePasswordReady } = require('../auth');
const { logAudit } = require('../audit');
const { notifyUsers, forcedMaintenanceRecipients } = require('../notifications');

const router = express.Router();
router.use(requireAuth);
router.use(requirePasswordReady);

router.get('/mine', async (req, res) => {
  try {
    const params = [];
    let where = '';
    if (req.user.role === 'admin') {
      where = '';
    } else {
      params.push(req.user.id);
      where = 'WHERE user_id=$1';
    }

    const { rows } = await pool.query(
      `SELECT id, issue_id, user_id, phone, event_type, message, status, error, created_at
       FROM notification_logs
       ${where}
       ORDER BY created_at DESC
       LIMIT 30`,
      params
    );
    res.json(rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Could not load notifications' });
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

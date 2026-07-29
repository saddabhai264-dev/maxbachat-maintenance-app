const express = require('express');
const bcrypt = require('bcryptjs');
const pool = require('../db');
const { requireAuth, requirePasswordReady } = require('../auth');
const { logAudit } = require('../audit');

const router = express.Router();
router.use(requireAuth);
router.use(requirePasswordReady);

function requireAdmin(req, res, next) {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });
  next();
}

router.use(requireAdmin);

router.get('/', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, role, branch_code, name, phone, is_head, is_active, must_change_password, created_at
       FROM users ORDER BY role, branch_code NULLS LAST, id`
    );
    res.json(rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Could not load users' });
  }
});

router.post('/', async (req, res) => {
  const { id, password, role, branchCode, name, phone, isHead } = req.body || {};
  const userId = String(id || '').trim().toUpperCase();
  if (!userId || !password || !role || !name) {
    return res.status(400).json({ error: 'ID, password, role and name are required' });
  }
  if (!['captain', 'auditor', 'coordinator', 'reporter', 'admin', 'ceo'].includes(role)) {
    return res.status(400).json({ error: 'Invalid role' });
  }
  if (String(password).length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });

  try {
    const hash = await bcrypt.hash(String(password), 12);
    await pool.query(
      `INSERT INTO users (id, password_hash, role, branch_code, name, phone, is_head, is_active, must_change_password)
       VALUES ($1,$2,$3,$4,$5,$6,$7,true,true)`,
      [userId, hash, role, branchCode || null, name, phone || null, !!isHead]
    );
    if (role === 'coordinator' && branchCode) {
      await pool.query(
        `INSERT INTO user_routes (user_id, branch_code) VALUES ($1,$2)
         ON CONFLICT (user_id, branch_code) DO NOTHING`,
        [userId, branchCode]
      );
    }
    await logAudit(req.user, 'user_created', 'user', userId, { role, branchCode: branchCode || null });
    res.json({ ok: true });
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'User ID already exists' });
    console.error(e);
    res.status(500).json({ error: 'Could not create user' });
  }
});

router.post('/:id/phone', async (req, res) => {
  const { phone } = req.body || {};
  try {
    const { rowCount } = await pool.query(
      'UPDATE users SET phone=$1 WHERE id=$2',
      [phone || null, req.params.id.toUpperCase()]
    );
    if (!rowCount) return res.status(404).json({ error: 'User not found' });
    await logAudit(req.user, 'user_phone_updated', 'user', req.params.id.toUpperCase());
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Could not update phone' });
  }
});

router.post('/:id/reset-password', async (req, res) => {
  const { password } = req.body || {};
  if (!password || String(password).length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters' });
  }
  try {
    const hash = await bcrypt.hash(String(password), 12);
    const { rowCount } = await pool.query(
      'UPDATE users SET password_hash=$1, must_change_password=true WHERE id=$2',
      [hash, req.params.id.toUpperCase()]
    );
    if (!rowCount) return res.status(404).json({ error: 'User not found' });
    await logAudit(req.user, 'user_password_reset', 'user', req.params.id.toUpperCase());
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Could not reset password' });
  }
});

router.post('/:id/status', async (req, res) => {
  const { isActive } = req.body || {};
  if (req.params.id.toUpperCase() === req.user.id && isActive === false) {
    return res.status(400).json({ error: 'You cannot disable your own admin account' });
  }
  try {
    const { rowCount } = await pool.query(
      'UPDATE users SET is_active=$1 WHERE id=$2',
      [!!isActive, req.params.id.toUpperCase()]
    );
    if (!rowCount) return res.status(404).json({ error: 'User not found' });
    await logAudit(req.user, isActive ? 'user_enabled' : 'user_disabled', 'user', req.params.id.toUpperCase());
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Could not update user status' });
  }
});

router.get('/audit/logs', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, actor_id, actor_name, action, target_type, target_id, details, created_at
       FROM audit_logs ORDER BY created_at DESC LIMIT 200`
    );
    res.json(rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Could not load audit logs' });
  }
});

router.get('/notifications/logs', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, issue_id, user_id, phone, event_type, message, status, error, created_at
       FROM notification_logs ORDER BY created_at DESC LIMIT 200`
    );
    res.json(rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Could not load notification logs' });
  }
});

module.exports = router;

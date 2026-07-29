const express = require('express');
const bcrypt = require('bcryptjs');
const pool = require('../db');
const { sign, requireAuth } = require('../auth');
const { logAudit } = require('../audit');

const router = express.Router();

router.post('/login', async (req, res) => {
  const { id, password } = req.body || {};
  if (!id || !password) return res.status(400).json({ error: 'ID and password required' });

  try {
    const loginId = String(id).trim();
    const normalizedPhone = loginId.replace(/[^\d]/g, '');
    const { rows } = await pool.query(
      `SELECT * FROM users
       WHERE id = $1
          OR ($2 <> '' AND regexp_replace(coalesce(phone,''), '[^0-9]', '', 'g') = $2)
       ORDER BY id = $1 DESC
       LIMIT 1`,
      [loginId.toUpperCase(), normalizedPhone]
    );
    const user = rows[0];
    if (!user) return res.status(401).json({ error: 'Incorrect ID or password' });
    if (!user.is_active) return res.status(403).json({ error: 'This account is disabled. Please contact admin.' });

    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) return res.status(401).json({ error: 'Incorrect ID or password' });

    let routes = user.branch_code ? [user.branch_code] : [];
    if (user.role === 'coordinator') {
      const r = await pool.query('SELECT branch_code FROM user_routes WHERE user_id = $1', [user.id]);
      routes = r.rows.map(x => x.branch_code);
    }

    const token = sign(user, routes);
    res.json({
      token,
      user: {
        id: user.id,
        role: user.role,
        branch: user.branch_code,
        name: user.name,
        isHead: user.is_head,
        isActive: user.is_active,
        mustChangePassword: user.must_change_password,
        routes
      }
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Login failed, please try again' });
  }
});

router.post('/change-password', requireAuth, async (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (!currentPassword || !newPassword) {
    return res.status(400).json({ error: 'Current password and new password are required' });
  }
  if (String(newPassword).length < 8) {
    return res.status(400).json({ error: 'New password must be at least 8 characters long' });
  }
  if (String(newPassword) === String(currentPassword)) {
    return res.status(400).json({ error: 'New password must be different from the current password' });
  }

  try {
    const { rows } = await pool.query('SELECT * FROM users WHERE id = $1', [req.user.id]);
    const user = rows[0];
    if (!user) return res.status(404).json({ error: 'User not found' });

    const ok = await bcrypt.compare(currentPassword, user.password_hash);
    if (!ok) return res.status(401).json({ error: 'Current password is incorrect' });

    const hash = await bcrypt.hash(String(newPassword), 12);
    await pool.query(
      'UPDATE users SET password_hash = $1, must_change_password = false WHERE id = $2',
      [hash, user.id]
    );
    await logAudit(req.user, 'password_changed', 'user', user.id);

    user.must_change_password = false;
    const routes = req.user.routes || (user.branch_code ? [user.branch_code] : []);
    const token = sign(user, routes);
    res.json({
      token,
      user: {
        id: user.id,
        role: user.role,
        branch: user.branch_code,
        name: user.name,
        isHead: user.is_head,
        isActive: user.is_active,
        mustChangePassword: false,
        routes
      }
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Could not change password' });
  }
});

module.exports = router;

const express = require('express');
const pool = require('../db');
const { requireAuth, requirePasswordReady } = require('../auth');

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

module.exports = router;

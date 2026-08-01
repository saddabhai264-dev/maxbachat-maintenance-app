const express = require('express');
const pool = require('../db');
const { requireAuth, requirePasswordReady } = require('../auth');
const { logAudit } = require('../audit');

const router = express.Router();
router.use(requireAuth);
router.use(requirePasswordReady);

router.get('/', async (req, res) => {
  try {
    const params = [];
    let where = '';
    if (req.user.role === 'coordinator') {
      params.push(req.user.id);
      where = 'WHERE user_id=$1';
    } else if (!['admin', 'ceo'].includes(req.user.role)) {
      return res.status(403).json({ error: 'Not allowed' });
    }

    const { rows } = await pool.query(
      `SELECT id, user_id, user_name, branch_code, note, latitude, longitude, visited_at
       FROM visit_logs
       ${where}
       ORDER BY visited_at DESC
       LIMIT 300`,
      params
    );
    res.json(rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Could not load visits' });
  }
});

router.post('/', async (req, res) => {
  const u = req.user;
  if (u.role !== 'coordinator') return res.status(403).json({ error: 'Only maintenance team can log visits' });

  const { branchCode, note, latitude, longitude } = req.body || {};
  if (!branchCode) return res.status(400).json({ error: 'Branch is required' });
  if (!Array.isArray(u.routes) || !u.routes.includes(branchCode)) {
    return res.status(403).json({ error: 'This branch is not in your route' });
  }

  try {
    const { rows } = await pool.query(
      `INSERT INTO visit_logs (user_id, user_name, branch_code, note, latitude, longitude)
       VALUES ($1,$2,$3,$4,$5,$6)
       RETURNING id`,
      [u.id, u.name, branchCode, note || null, latitude || null, longitude || null]
    );
    await logAudit(u, 'branch_visit_logged', 'visit', rows[0].id, { branch: branchCode });
    res.json({ id: rows[0].id });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Could not save visit' });
  }
});

module.exports = router;

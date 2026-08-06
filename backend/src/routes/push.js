const express = require('express');
const pool = require('../db');
const { requireAuth, requirePasswordReady } = require('../auth');

const router = express.Router();
router.use(requireAuth);
router.use(requirePasswordReady);

router.get('/public-key', (req, res) => {
  if (!process.env.VAPID_PUBLIC_KEY) return res.status(503).json({ error: 'Push notifications are not configured' });
  res.json({ publicKey: process.env.VAPID_PUBLIC_KEY });
});

router.post('/subscribe', async (req, res) => {
  const { subscription } = req.body || {};
  if (!subscription || !subscription.endpoint) return res.status(400).json({ error: 'Subscription is required' });

  try {
    await pool.query(
      `INSERT INTO push_subscriptions (user_id, endpoint, subscription, updated_at)
       VALUES ($1,$2,$3,now())
       ON CONFLICT (endpoint) DO UPDATE SET
         user_id = EXCLUDED.user_id,
         subscription = EXCLUDED.subscription,
         updated_at = now()`,
      [req.user.id, subscription.endpoint, subscription]
    );
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Could not save push subscription' });
  }
});

module.exports = router;

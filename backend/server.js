require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');

const authRoutes = require('./src/routes/auth');
const issueRoutes = require('./src/routes/issues');
const mediaRoutes = require('./src/routes/media');
const userRoutes = require('./src/routes/users');
const pool = require('./src/db');

const app = express();
app.set('trust proxy', 1);

const allowedOrigin = process.env.CORS_ORIGIN || '*';
app.use(helmet({ crossOriginResourcePolicy: false }));
app.use(cors({ origin: allowedOrigin }));
app.use(express.json({ limit: '8mb' }));

app.use('/api/auth/login', rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts. Please wait a few minutes and try again.' }
}));

app.get('/health', (req, res) => res.json({ ok: true }));
app.get('/health/db', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ ok: true, db: true });
  } catch (e) {
    res.status(503).json({ ok: false, db: false });
  }
});

app.use('/api/auth', authRoutes);
app.use('/api/issues', issueRoutes);
app.use('/api/media', mediaRoutes);
app.use('/api/users', userRoutes);

const frontendDir = path.join(__dirname, '..', 'frontend');
app.use(express.static(frontendDir));
app.get('*', (req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Not found' });
  res.sendFile(path.join(frontendDir, 'index.html'));
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Something went wrong' });
});

if (require.main === module) {
  const PORT = process.env.PORT || 4000;
  app.listen(PORT, () => console.log(`MAXBACHAT maintenance API running on port ${PORT}`));
}

module.exports = app;

const jwt = require('jsonwebtoken');
const pool = require('./db');

function sign(user, routes) {
  return jwt.sign(
    {
      id: user.id,
      role: user.role,
      branch: user.branch_code,
      isHead: user.is_head,
      isActive: user.is_active,
      name: user.name,
      mustChangePassword: user.must_change_password,
      routes: routes || (user.branch_code ? [user.branch_code] : [])
    },
    process.env.JWT_SECRET,
    { expiresIn: '12h' }
  );
}

async function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Missing token' });
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    const { rows } = await pool.query(
      'SELECT is_active, must_change_password FROM users WHERE id=$1',
      [req.user.id]
    );
    if (!rows.length || !rows[0].is_active) {
      return res.status(403).json({ error: 'This account is disabled. Please contact admin.' });
    }
    req.user.mustChangePassword = rows[0].must_change_password;
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Invalid or expired session, please log in again' });
  }
}

function requirePasswordReady(req, res, next) {
  if (req.user && req.user.mustChangePassword) {
    return res.status(403).json({ error: 'Password change required before continuing' });
  }
  next();
}

module.exports = { sign, requireAuth, requirePasswordReady };

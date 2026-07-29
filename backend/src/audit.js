const pool = require('./db');

async function logAudit(actor, action, targetType, targetId, details = {}) {
  try {
    await pool.query(
      `INSERT INTO audit_logs (actor_id, actor_name, action, target_type, target_id, details)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [
        actor && actor.id ? actor.id : null,
        actor && actor.name ? actor.name : null,
        action,
        targetType,
        targetId || null,
        details
      ]
    );
  } catch (e) {
    console.error('Audit log failed:', e);
  }
}

module.exports = { logAudit };

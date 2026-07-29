// Populates branches, users (with bcrypt-hashed passwords), and maintenance-team routing.
// Run once after schema.sql has been applied:   npm run seed

require('dotenv').config();
const bcrypt = require('bcryptjs');
const pool = require('./src/db');

const BRANCHES = [
  ['BR1', 'Thandi Sarak', false],
  ['BR2', 'Qasimabad', false],
  ['BR3', 'MPK', false],
  ['BR4', 'Latifabad', false],
  ['JDC', 'JDC Warehouse', true],
  ['MANDI', 'Mandi', true]
];

// [id, initial password, role, branch, display name, is_head]
// NOTE: change these initial passwords after first login in a real production rollout.
const USERS = [
  ['CAP-BR1', '14512', 'captain', 'BR1', 'Captain - Thandi Sarak', false],
  ['CAP-BR2', '24512', 'captain', 'BR2', 'Captain - Qasimabad', false],
  ['CAP-BR3', '34512', 'captain', 'BR3', 'Captain - MPK', false],
  ['CAP-BR4', '44512', 'captain', 'BR4', 'Captain - Latifabad', false],

  ['AUD-BR1', '15623', 'auditor', 'BR1', 'Auditor - Thandi Sarak', false],
  ['AUD-BR2', '25623', 'auditor', 'BR2', 'Auditor - Qasimabad', false],
  ['AUD-BR3', '35623', 'auditor', 'BR3', 'Auditor - MPK', false],
  ['AUD-BR4', '45623', 'auditor', 'BR4', 'Auditor - Latifabad', false],

  ['MT-BR1', '16734', 'coordinator', 'BR1', 'Maintenance Team - Thandi Sarak', true],
  ['MT-BR2', '26734', 'coordinator', 'BR2', 'Maintenance Team - Qasimabad', false],
  ['MT-BR3', '36734', 'coordinator', 'BR3', 'Maintenance Team - MPK', false],
  ['MT-BR4', '46734', 'coordinator', 'BR4', 'Maintenance Team - Latifabad', false],

  ['REP-JDC', '58121', 'reporter', 'JDC', 'JDC Warehouse', false],
  ['REP-MANDI', '58231', 'reporter', 'MANDI', 'Mandi', false],

  ['ADMIN-HQ', '90909', 'admin', null, 'Head Office Admin', false],
  ['CEO-HQ', '70701', 'ceo', null, 'Chief Executive Officer', false]
];

const ROUTES = {
  'MT-BR1': ['BR1', 'JDC', 'MANDI'],
  'MT-BR2': ['BR2'],
  'MT-BR3': ['BR3'],
  'MT-BR4': ['BR4']
};

async function run() {
  for (const [code, name, noTeam] of BRANCHES) {
    await pool.query(
      `INSERT INTO branches (code, name, no_team) VALUES ($1,$2,$3)
       ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name, no_team = EXCLUDED.no_team`,
      [code, name, noTeam]
    );
  }

  for (const [id, pass, role, branch, name, isHead] of USERS) {
    const hash = await bcrypt.hash(pass, 10);
    await pool.query(
      `INSERT INTO users (id, password_hash, role, branch_code, name, is_head, is_active, must_change_password)
       VALUES ($1,$2,$3,$4,$5,$6, true, true)
       ON CONFLICT (id) DO UPDATE SET
         role = EXCLUDED.role,
         branch_code = EXCLUDED.branch_code,
         name = EXCLUDED.name,
         is_head = EXCLUDED.is_head,
         is_active = true`,
      [id, hash, role, branch, name, isHead]
    );
  }

  for (const [userId, codes] of Object.entries(ROUTES)) {
    await pool.query('DELETE FROM user_routes WHERE user_id = $1', [userId]);
    for (const code of codes) {
      await pool.query('INSERT INTO user_routes (user_id, branch_code) VALUES ($1,$2)', [userId, code]);
    }
  }

  console.log('Seed complete: branches, users, and maintenance-team routing are in place.');
  process.exit(0);
}

run().catch(e => {
  console.error('Seed failed:', e);
  process.exit(1);
});

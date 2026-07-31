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

// [id, initial password, role, branch, display name, is_head, phone]
// NOTE: change these initial passwords after first login in a real production rollout.
const USERS = [
  ['CAP-BR1', '14512', 'captain', 'BR1', 'Captain - Thandi Sarak', false, null],
  ['CAP-BR2', '24512', 'captain', 'BR2', 'Captain - Qasimabad', false, null],
  ['CAP-BR3', '34512', 'captain', 'BR3', 'Captain - MPK', false, null],
  ['CAP-BR4', '44512', 'captain', 'BR4', 'Captain - Latifabad', false, null],

  ['AUD-BR1', '15623', 'auditor', 'BR1', 'Auditor - Thandi Sarak', false, null],
  ['AUD-BR2', '25623', 'auditor', 'BR2', 'Auditor - Qasimabad', false, null],
  ['AUD-BR3', '35623', 'auditor', 'BR3', 'Auditor - MPK', false, null],
  ['AUD-BR4', '45623', 'auditor', 'BR4', 'Auditor - Latifabad', false, null],

  ['MT-BR1', '16734', 'coordinator', 'BR1', 'Fayaz - Maintenance Head', true, '+923053504982'],
  ['MT-BR2', '26734', 'coordinator', 'BR2', 'Amjad - Maintenance Team Qasimabad', false, '+923103875482'],
  ['MT-BR3', '36734', 'coordinator', 'BR3', 'Anees - Maintenance Team MPK', false, '+923133999727'],
  ['MT-BR4', '46734', 'coordinator', 'BR4', 'Asad - Maintenance Team Latifabad', false, '+923148030986'],

  ['REP-JDC', '58121', 'reporter', 'JDC', 'JDC Warehouse', false, null],
  ['REP-MANDI', '58231', 'reporter', 'MANDI', 'Mandi', false, null],

  ['ADMIN-HQ', '90909', 'admin', null, 'Head Office Admin', false, null],
  ['CEO-HQ', '70701', 'ceo', null, 'Chief Executive Officer', false, null]
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

  for (const [id, pass, role, branch, name, isHead, phone] of USERS) {
    const hash = await bcrypt.hash(pass, 10);
    await pool.query(
      `INSERT INTO users (id, password_hash, role, branch_code, name, is_head, phone, is_active, must_change_password)
       VALUES ($1,$2,$3,$4,$5,$6,$7, true, true)
       ON CONFLICT (id) DO UPDATE SET
         role = EXCLUDED.role,
         branch_code = EXCLUDED.branch_code,
         name = EXCLUDED.name,
         is_head = EXCLUDED.is_head,
         phone = EXCLUDED.phone,
         is_active = true`,
      [id, hash, role, branch, name, isHead, phone]
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

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const pool = require('./src/db');

async function run() {
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  await pool.query(sql);
  console.log('Database schema is up to date.');
  await pool.end();
}

run().catch(e => {
  console.error('Migration failed:', e);
  process.exit(1);
});

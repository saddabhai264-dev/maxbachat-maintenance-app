const { Pool } = require('pg');

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set. Copy .env.example to .env and fill it in.');
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // DigitalOcean managed databases require SSL. sslmode=require in the connection
  // string handles this, but some Node/OpenSSL combinations also need this explicit
  // flag because DO's certificate isn't in the default trust store.
  ssl: { rejectUnauthorized: false }
});

module.exports = pool;

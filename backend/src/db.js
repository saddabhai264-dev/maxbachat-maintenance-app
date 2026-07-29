const { Pool } = require('pg');

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set. Copy .env.example to .env and fill it in.');
}

function databaseUrlWithoutSslMode(raw) {
  if (!raw) return raw;
  try {
    const url = new URL(raw);
    url.searchParams.delete('sslmode');
    url.searchParams.delete('uselibpqcompat');
    return url.toString();
  } catch (e) {
    return raw.replace(/[?&](sslmode|uselibpqcompat)=[^&]*/g, '');
  }
}

const pool = new Pool({
  connectionString: databaseUrlWithoutSslMode(process.env.DATABASE_URL),
  // DigitalOcean managed databases require SSL. sslmode=require in the connection
  // string handles this, but some Node/OpenSSL combinations also need this explicit
  // flag because DO's certificate isn't in the default trust store.
  ssl: process.env.PGSSLMODE === 'disable' ? false : { rejectUnauthorized: false }
});

module.exports = pool;

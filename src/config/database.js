const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 5,
  idleTimeoutMillis: 30000,      // drop idle connections after 30s (Neon kills them after 5min)
  connectionTimeoutMillis: 10000,
});

pool.on('error', (err) => {
  // ECONNRESET = Neon dropped the connection on its side; pool will open a fresh one
  console.error('PostgreSQL pool error (will reconnect):', err.message);
});

module.exports = pool;

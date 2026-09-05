const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('railway') ? { rejectUnauthorized: false } : false,
});

async function initDB() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS wallet_topups (
        id SERIAL PRIMARY KEY,
        location_id VARCHAR(255) NOT NULL,
        location_name VARCHAR(255),
        amount_php NUMERIC(12, 2) NOT NULL,
        notes TEXT,
        added_by VARCHAR(255) DEFAULT 'admin',
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS wallet_balances (
        location_id VARCHAR(255) PRIMARY KEY,
        location_name VARCHAR(255),
        total_topup_php NUMERIC(12, 2) DEFAULT 0,
        total_usage_usd NUMERIC(12, 4) DEFAULT 0,
        total_usage_php NUMERIC(12, 2) DEFAULT 0,
        balance_php NUMERIC(12, 2) DEFAULT 0,
        last_updated TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_topups_location_id ON wallet_topups(location_id);
      CREATE INDEX IF NOT EXISTS idx_topups_created_at ON wallet_topups(created_at DESC);
    `);
    console.log('[db] Tables initialized');
  } finally {
    client.release();
  }
}

module.exports = { pool, initDB };

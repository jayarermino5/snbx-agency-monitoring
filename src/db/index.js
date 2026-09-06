const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('railway') ? { rejectUnauthorized: false } : false,
});

async function initDB() {
  const client = await pool.connect();
  try {
    await client.query(`
      -- Top-up records
      CREATE TABLE IF NOT EXISTS wallet_topups (
        id SERIAL PRIMARY KEY,
        location_id VARCHAR(255) NOT NULL,
        location_name VARCHAR(255),
        amount_php NUMERIC(12, 2) NOT NULL,
        month VARCHAR(7) NOT NULL DEFAULT TO_CHAR(NOW(), 'YYYY-MM'),
        notes TEXT,
        added_by VARCHAR(255) DEFAULT 'Jay-ar',
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      -- Monthly usage ledger — one row per location per month
      CREATE TABLE IF NOT EXISTS monthly_ledger (
        id SERIAL PRIMARY KEY,
        location_id VARCHAR(255) NOT NULL,
        location_name VARCHAR(255),
        month VARCHAR(7) NOT NULL,
        opening_balance_php NUMERIC(12, 2) DEFAULT 0,
        topup_php NUMERIC(12, 2) DEFAULT 0,
        wallet_usage_usd NUMERIC(12, 4) DEFAULT 0,
        ai_usage_usd NUMERIC(12, 4) DEFAULT 0,
        ai_is_free BOOLEAN DEFAULT FALSE,
        total_deduction_php NUMERIC(12, 2) DEFAULT 0,
        closing_balance_php NUMERIC(12, 2) DEFAULT 0,
        last_updated TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(location_id, month)
      );

      -- Current balance view per location (latest month)
      CREATE TABLE IF NOT EXISTS wallet_balances (
        location_id VARCHAR(255) PRIMARY KEY,
        location_name VARCHAR(255),
        current_balance_php NUMERIC(12, 2) DEFAULT 0,
        current_month VARCHAR(7),
        total_topup_php NUMERIC(12, 2) DEFAULT 0,
        total_usage_php NUMERIC(12, 2) DEFAULT 0,
        total_usage_usd NUMERIC(12, 4) DEFAULT 0,
        last_updated TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_topups_location_id ON wallet_topups(location_id);
      CREATE INDEX IF NOT EXISTS idx_topups_month ON wallet_topups(month);
      CREATE INDEX IF NOT EXISTS idx_ledger_location_month ON monthly_ledger(location_id, month);
      CREATE INDEX IF NOT EXISTS idx_ledger_month ON monthly_ledger(month);
    `);
    // Migrations — add new columns if they don't exist
    await client.query(`
      ALTER TABLE wallet_topups ADD COLUMN IF NOT EXISTS month VARCHAR(7) DEFAULT TO_CHAR(NOW(), 'YYYY-MM');
    `);

    console.log('[db] Tables initialized');
  } finally {
    client.release();
  }
}

module.exports = { pool, initDB };

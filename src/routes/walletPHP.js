const express = require('express');
const { pool } = require('../db');

const router = express.Router();

// USD to PHP conversion rate — update as needed
const USD_TO_PHP = parseFloat(process.env.USD_TO_PHP_RATE || '58');
const MARKUP = 1.5;

function usdToPhp(usd) {
  return parseFloat((usd * MARKUP * USD_TO_PHP).toFixed(2));
}

// GET /api/php/balances
// Returns all sub-account balances
router.get('/balances', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        wb.*,
        COALESCE(
          (SELECT json_agg(t ORDER BY t.created_at DESC)
           FROM wallet_topups t
           WHERE t.location_id = wb.location_id),
          '[]'
        ) AS topup_history
      FROM wallet_balances wb
      ORDER BY wb.balance_php ASC
    `);
    res.json({ success: true, data: result.rows, usdToPhp: USD_TO_PHP, markup: MARKUP });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/php/balances/:locationId
// Returns single sub-account balance + full history
router.get('/balances/:locationId', async (req, res) => {
  try {
    const { locationId } = req.params;
    const [balance, topups] = await Promise.all([
      pool.query('SELECT * FROM wallet_balances WHERE location_id = $1', [locationId]),
      pool.query('SELECT * FROM wallet_topups WHERE location_id = $1 ORDER BY created_at DESC', [locationId]),
    ]);
    if (!balance.rows.length) {
      return res.status(404).json({ error: 'Location not found in wallet system' });
    }
    res.json({
      success: true,
      balance: balance.rows[0],
      topups: topups.rows,
      usdToPhp: USD_TO_PHP,
      markup: MARKUP,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/php/topup
// Add peso credit to a sub-account
// Body: { locationId, locationName, amountPhp, notes, addedBy }
router.post('/topup', async (req, res) => {
  const { locationId, locationName, amountPhp, notes, addedBy } = req.body;
  if (!locationId || !amountPhp) {
    return res.status(400).json({ error: 'locationId and amountPhp are required' });
  }
  if (isNaN(amountPhp) || amountPhp <= 0) {
    return res.status(400).json({ error: 'amountPhp must be a positive number' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Insert top-up record
    await client.query(
      `INSERT INTO wallet_topups (location_id, location_name, amount_php, notes, added_by)
       VALUES ($1, $2, $3, $4, $5)`,
      [locationId, locationName, amountPhp, notes || null, addedBy || 'admin']
    );

    // Upsert balance — recalculate total top-up
    await client.query(
      `INSERT INTO wallet_balances (location_id, location_name, total_topup_php, total_usage_php, balance_php, last_updated)
       VALUES ($1, $2, $3, 0, $3, NOW())
       ON CONFLICT (location_id) DO UPDATE SET
         location_name = EXCLUDED.location_name,
         total_topup_php = (
           SELECT COALESCE(SUM(amount_php), 0)
           FROM wallet_topups
           WHERE location_id = $1
         ),
         balance_php = (
           SELECT COALESCE(SUM(amount_php), 0)
           FROM wallet_topups
           WHERE location_id = $1
         ) - wallet_balances.total_usage_php,
         last_updated = NOW()`,
      [locationId, locationName, amountPhp]
    );

    await client.query('COMMIT');

    const updated = await pool.query('SELECT * FROM wallet_balances WHERE location_id = $1', [locationId]);
    res.json({ success: true, message: 'Top-up added successfully', balance: updated.rows[0] });
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

// DELETE /api/php/topup/:id
// Remove a top-up entry (correction)
router.delete('/topup/:id', async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const topup = await client.query('SELECT * FROM wallet_topups WHERE id = $1', [req.params.id]);
    if (!topup.rows.length) return res.status(404).json({ error: 'Top-up not found' });

    const { location_id } = topup.rows[0];
    await client.query('DELETE FROM wallet_topups WHERE id = $1', [req.params.id]);

    // Recalculate balance
    await client.query(
      `UPDATE wallet_balances SET
         total_topup_php = (SELECT COALESCE(SUM(amount_php), 0) FROM wallet_topups WHERE location_id = $1),
         balance_php = (SELECT COALESCE(SUM(amount_php), 0) FROM wallet_topups WHERE location_id = $1) - total_usage_php,
         last_updated = NOW()
       WHERE location_id = $1`,
      [location_id]
    );

    await client.query('COMMIT');
    res.json({ success: true, message: 'Top-up removed and balance recalculated' });
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

// POST /api/php/sync-usage
// Called after each scrape — updates usage amounts from GHL wallet data
// Body: { locations: [{ locationId, locationName, totalUsageUsd }] }
router.post('/sync-usage', async (req, res) => {
  const { locations } = req.body;
  if (!locations?.length) return res.status(400).json({ error: 'locations array required' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    for (const loc of locations) {
      const usagePhp = usdToPhp(loc.totalUsageUsd || 0);
      await client.query(
        `INSERT INTO wallet_balances (location_id, location_name, total_topup_php, total_usage_usd, total_usage_php, balance_php, last_updated)
         VALUES ($1, $2, 0, $3, $4, (0 - $4::numeric), NOW())
         ON CONFLICT (location_id) DO UPDATE SET
           location_name = EXCLUDED.location_name,
           total_usage_usd = $3,
           total_usage_php = $4,
           balance_php = wallet_balances.total_topup_php - $4,
           last_updated = NOW()`,
        [loc.locationId, loc.locationName, loc.totalUsageUsd || 0, usagePhp]
      );
    }

    await client.query('COMMIT');
    res.json({ success: true, synced: locations.length });
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

// GET /api/php/summary
// Dashboard summary — total credits issued, total consumed, total balance
router.get('/summary', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        COUNT(*) as total_accounts,
        COALESCE(SUM(total_topup_php), 0) as total_topup_php,
        COALESCE(SUM(total_usage_php), 0) as total_usage_php,
        COALESCE(SUM(balance_php), 0) as total_balance_php,
        COUNT(CASE WHEN balance_php < 0 THEN 1 END) as overdue_accounts,
        COUNT(CASE WHEN balance_php < 500 AND balance_php >= 0 THEN 1 END) as low_balance_accounts
      FROM wallet_balances
    `);
    res.json({ success: true, summary: result.rows[0], usdToPhp: USD_TO_PHP, markup: MARKUP });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;

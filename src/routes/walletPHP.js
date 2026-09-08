const express = require('express');
const { pool } = require('../db');

const router = express.Router();

const USD_TO_PHP = () => parseFloat(process.env.USD_TO_PHP_RATE || '58');
const MARKUP = 1.5;
const BILLING_START = '2026-09'; // Only deduct from Sep 2026 onwards

function usdToPhp(usd) {
  return parseFloat((usd * MARKUP * USD_TO_PHP()).toFixed(2));
}

// GET /api/php/summary
router.get('/summary', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        COUNT(*) as total_accounts,
        COALESCE(SUM(total_topup_php), 0) as total_topup_php,
        COALESCE(SUM(total_usage_php), 0) as total_usage_php,
        COALESCE(SUM(balance_php), 0) as total_balance_php,
        COUNT(CASE WHEN balance_php < 0 THEN 1 END) as overdue_accounts,
        COUNT(CASE WHEN balance_php >= 0 AND balance_php < 500 THEN 1 END) as low_balance_accounts
      FROM wallet_balances
    `);
    res.json({
      success: true,
      summary: result.rows[0],
      usdToPhp: USD_TO_PHP(),
      markup: MARKUP,
      billingStart: BILLING_START,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/php/balances
router.get('/balances', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT wb.*,
        COALESCE((
          SELECT json_agg(t ORDER BY t.created_at DESC)
          FROM wallet_topups t WHERE t.location_id = wb.location_id
        ), '[]') as topup_history
      FROM wallet_balances wb
      ORDER BY wb.balance_php ASC
    `);
    res.json({ success: true, data: result.rows, usdToPhp: USD_TO_PHP(), markup: MARKUP });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/php/balances/:locationId
router.get('/balances/:locationId', async (req, res) => {
  try {
    const { locationId } = req.params;
    const [balance, topups] = await Promise.all([
      pool.query('SELECT * FROM wallet_balances WHERE location_id = $1', [locationId]),
      pool.query('SELECT * FROM wallet_topups WHERE location_id = $1 ORDER BY created_at DESC', [locationId]),
    ]);
    if (!balance.rows.length) {
      return res.status(404).json({ error: 'No wallet record found' });
    }
    res.json({
      success: true,
      balance: balance.rows[0],
      topups: topups.rows,
      usdToPhp: USD_TO_PHP(),
      markup: MARKUP,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/php/topup
router.post('/topup', async (req, res) => {
  const { locationId, locationName, amountPhp, notes, addedBy } = req.body;
  if (!locationId || !amountPhp) return res.status(400).json({ error: 'locationId and amountPhp required' });
  if (isNaN(amountPhp) || amountPhp <= 0) return res.status(400).json({ error: 'amountPhp must be positive' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Insert top-up record
    await client.query(
      `INSERT INTO wallet_topups (location_id, location_name, amount_php, notes, added_by)
       VALUES ($1, $2, $3, $4, $5)`,
      [locationId, locationName, amountPhp, notes || null, addedBy || 'Jay-ar']
    );

    // Upsert wallet_balances — recalculate total topup and balance
    await client.query(
      `INSERT INTO wallet_balances (location_id, location_name, total_topup_php, total_usage_php, balance_php, last_updated)
       VALUES ($1, $2, $3::numeric, 0, $3::numeric, NOW())
       ON CONFLICT (location_id) DO UPDATE SET
         location_name = $2,
         total_topup_php = (SELECT COALESCE(SUM(amount_php), 0) FROM wallet_topups WHERE location_id = $1),
         balance_php = (SELECT COALESCE(SUM(amount_php), 0) FROM wallet_topups WHERE location_id = $1) - wallet_balances.total_usage_php,
         last_updated = NOW()`,
      [locationId, locationName, amountPhp]
    );

    await client.query('COMMIT');

    const updated = await pool.query('SELECT * FROM wallet_balances WHERE location_id = $1', [locationId]);
    res.json({ success: true, message: 'Top-up added', balance: updated.rows[0] });
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

// DELETE /api/php/topup/:id
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
    res.json({ success: true, message: 'Top-up removed' });
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

// POST /api/php/sync-usage
// Called after each scrape — computes current month usage in PHP and updates balances
router.post('/sync-usage', async (req, res) => {
  const { locations } = req.body;
  if (!locations?.length) return res.status(400).json({ error: 'locations required' });

  const curMonth = new Date();
  const monthKey = `${curMonth.getFullYear()}-${String(curMonth.getMonth() + 1).padStart(2, '0')}`;
  const isBillingMonth = monthKey >= BILLING_START;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    for (const loc of locations) {
      // Only deduct current month usage, only from Sep 2026 onwards
      let usagePhp = 0;
      if (isBillingMonth) {
        const curMonthWallet = parseFloat(loc.months?.[monthKey]?.amount || 0);
        const curMonthAI = parseFloat(loc.aiUsageThisMonth || 0);
        usagePhp = usdToPhp(curMonthWallet + curMonthAI);
      }

      // Upsert balance — preserve existing top-ups
      await client.query(
        `INSERT INTO wallet_balances (location_id, location_name, total_topup_php, total_usage_php, balance_php, last_updated)
         VALUES ($1, $2, 0, $3::numeric, (0 - $3::numeric), NOW())
         ON CONFLICT (location_id) DO UPDATE SET
           location_name = $2,
           total_usage_php = $3::numeric,
           balance_php = wallet_balances.total_topup_php - $3::numeric,
           last_updated = NOW()`,
        [loc.locationId, loc.locationName, usagePhp]
      );
    }

    await client.query('COMMIT');
    res.json({ success: true, synced: locations.length, billingActive: isBillingMonth, month: monthKey });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('[sync-usage] error:', e.message);
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

module.exports = router;

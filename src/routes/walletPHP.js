const express = require('express');
const { pool } = require('../db');

const router = express.Router();

const USD_TO_PHP = () => parseFloat(process.env.USD_TO_PHP_RATE || '58');
const MARKUP = 1.5;

// Billing starts from September 2026 — nothing before this month is deducted
const BILLING_START_MONTH = '2026-09';

function isBillingMonth(month) {
  // Only deduct from BILLING_START_MONTH onwards
  return month >= BILLING_START_MONTH;
}

function isAiFree(month) {
  // AI is free before billing start month
  return month < BILLING_START_MONTH;
}

function usdToPhp(usd) {
  return parseFloat((usd * MARKUP * USD_TO_PHP()).toFixed(2));
}

function currentMonth() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

// Recalculate the full ledger for a location from scratch
// Processes months in chronological order, carrying balance forward
async function recalculateLedger(client, locationId) {
  // Get all months with activity sorted ascending
  const ledgerRows = await client.query(
    `SELECT * FROM monthly_ledger WHERE location_id = $1 ORDER BY month ASC`,
    [locationId]
  );

  let runningBalance = 0;

  for (const row of ledgerRows.rows) {
    // Get top-ups for this month
    const topupResult = await client.query(
      `SELECT COALESCE(SUM(amount_php), 0) as total FROM wallet_topups WHERE location_id = $1 AND month = $2`,
      [locationId, row.month]
    );
    const topupPhp = parseFloat(topupResult.rows[0].total);

    // Calculate deduction — only for billing months (Sep 2026 onwards)
    const billingActive = isBillingMonth(row.month);
    const walletDeduction = billingActive ? usdToPhp(parseFloat(row.wallet_usage_usd) || 0) : 0;
    const aiDeduction = (billingActive && !row.ai_is_free) ? usdToPhp(parseFloat(row.ai_usage_usd) || 0) : 0;
    const totalDeduction = parseFloat((walletDeduction + aiDeduction).toFixed(2));

    // Opening = previous closing, closing = opening + topup - deduction
    const openingBalance = runningBalance;
    const closingBalance = parseFloat((openingBalance + topupPhp - totalDeduction).toFixed(2));
    runningBalance = closingBalance;

    await client.query(
      `UPDATE monthly_ledger SET
        opening_balance_php = $1,
        topup_php = $2,
        total_deduction_php = $3,
        closing_balance_php = $4,
        last_updated = NOW()
      WHERE location_id = $5 AND month = $6`,
      [openingBalance, topupPhp, totalDeduction, closingBalance, locationId, row.month]
    );
  }

  return runningBalance;
}

// GET /api/php/summary
router.get('/summary', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        COUNT(*) as total_accounts,
        COALESCE(SUM(total_topup_php), 0) as total_topup_php,
        COALESCE(SUM(total_usage_php), 0) as total_usage_php,
        COALESCE(SUM(current_balance_php), 0) as total_balance_php,
        COUNT(CASE WHEN current_balance_php < 0 THEN 1 END) as overdue_accounts,
        COUNT(CASE WHEN current_balance_php < 500 AND current_balance_php >= 0 THEN 1 END) as low_balance_accounts
      FROM wallet_balances
    `);
    res.json({
      success: true,
      summary: result.rows[0],
      usdToPhp: USD_TO_PHP(),
      markup: MARKUP,
      aiFreeMonths: AI_FREE_MONTHS,
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
      ORDER BY wb.current_balance_php ASC
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
    const [balance, ledger, topups] = await Promise.all([
      pool.query('SELECT * FROM wallet_balances WHERE location_id = $1', [locationId]),
      pool.query('SELECT * FROM monthly_ledger WHERE location_id = $1 ORDER BY month DESC', [locationId]),
      pool.query('SELECT * FROM wallet_topups WHERE location_id = $1 ORDER BY created_at DESC', [locationId]),
    ]);
    if (!balance.rows.length) {
      return res.status(404).json({ error: 'Location not found in wallet system' });
    }
    res.json({
      success: true,
      balance: balance.rows[0],
      ledger: ledger.rows,
      topups: topups.rows,
      usdToPhp: USD_TO_PHP(),
      markup: MARKUP,
      aiFreeMonths: AI_FREE_MONTHS,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/php/topup
router.post('/topup', async (req, res) => {
  const { locationId, locationName, amountPhp, notes, addedBy, month } = req.body;
  if (!locationId || !amountPhp) return res.status(400).json({ error: 'locationId and amountPhp required' });
  if (isNaN(amountPhp) || amountPhp <= 0) return res.status(400).json({ error: 'amountPhp must be positive' });

  const topupMonth = month || currentMonth();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Insert top-up
    await client.query(
      `INSERT INTO wallet_topups (location_id, location_name, amount_php, month, notes, added_by)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [locationId, locationName, amountPhp, topupMonth, notes || null, addedBy || 'Jay-ar']
    );

    // Ensure ledger row exists for this month
    await client.query(
      `INSERT INTO monthly_ledger (location_id, location_name, month, ai_is_free)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (location_id, month) DO NOTHING`,
      [locationId, locationName, topupMonth, isAiFree(topupMonth)]
    );

    // Recalculate full ledger
    const newBalance = await recalculateLedger(client, locationId);

    // Update wallet_balances
    const totalTopup = await client.query(
      `SELECT COALESCE(SUM(amount_php), 0) as total FROM wallet_topups WHERE location_id = $1`,
      [locationId]
    );
    const totalUsage = await client.query(
      `SELECT COALESCE(SUM(total_deduction_php), 0) as total FROM monthly_ledger WHERE location_id = $1`,
      [locationId]
    );

    await client.query(
      `UPDATE wallet_balances SET
        location_name = $2,
        current_balance_php = $3,
        current_month = $4,
        total_topup_php = $5,
        total_usage_php = $6,
        last_updated = NOW()
       WHERE location_id = $1`,
      [locationId, locationName, newBalance, topupMonth,
        parseFloat(totalTopup.rows[0].total), parseFloat(totalUsage.rows[0].total)]
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

    const { location_id, location_name } = topup.rows[0];
    await client.query('DELETE FROM wallet_topups WHERE id = $1', [req.params.id]);

    const newBalance = await recalculateLedger(client, location_id);

    const totalTopup = await client.query(
      `SELECT COALESCE(SUM(amount_php), 0) as total FROM wallet_topups WHERE location_id = $1`,
      [location_id]
    );
    const totalUsage = await client.query(
      `SELECT COALESCE(SUM(total_deduction_php), 0) as total FROM monthly_ledger WHERE location_id = $1`,
      [location_id]
    );

    await client.query(
      `UPDATE wallet_balances SET
        current_balance_php = $2,
        total_topup_php = $3,
        total_usage_php = $4,
        last_updated = NOW()
       WHERE location_id = $1`,
      [location_id, newBalance,
        parseFloat(totalTopup.rows[0].total), parseFloat(totalUsage.rows[0].total)]
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
// Called after each scrape — updates monthly ledger from GHL data
router.post('/sync-usage', async (req, res) => {
  const { locations } = req.body;
  if (!locations?.length) return res.status(400).json({ error: 'locations array required' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    for (const loc of locations) {
      // Process each month's wallet usage
      const months = loc.months || {};
      for (const [month, data] of Object.entries(months)) {
        const walletUsd = parseFloat(data.amount || 0);
        const aiUsd = parseFloat(loc.aiUsageByMonth?.[month] || 0);
        // Mark as free if before billing start (wallet AND AI both free before Sep 2026)
        const aiFree = isAiFree(month);

        // Upsert ledger row
        await client.query(
          `INSERT INTO monthly_ledger
            (location_id, location_name, month, wallet_usage_usd, ai_usage_usd, ai_is_free)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (location_id, month) DO UPDATE SET
            location_name = EXCLUDED.location_name,
            wallet_usage_usd = EXCLUDED.wallet_usage_usd,
            ai_usage_usd = EXCLUDED.ai_usage_usd,
            ai_is_free = EXCLUDED.ai_is_free,
            last_updated = NOW()`,
          [loc.locationId, loc.locationName, month, walletUsd, aiUsd, aiFree]
        );
      }

      // Recalculate full ledger for this location
      const newBalance = await recalculateLedger(client, loc.locationId);

      const totalTopup = await client.query(
        `SELECT COALESCE(SUM(amount_php), 0) as total FROM wallet_topups WHERE location_id = $1`,
        [loc.locationId]
      );
      const totalUsage = await client.query(
        `SELECT COALESCE(SUM(total_deduction_php), 0) as total FROM monthly_ledger WHERE location_id = $1`,
        [loc.locationId]
      );
      const totalUsageUsd = await client.query(
        `SELECT COALESCE(SUM(wallet_usage_usd + ai_usage_usd), 0) as total FROM monthly_ledger WHERE location_id = $1`,
        [loc.locationId]
      );

      // Upsert wallet_balances
      await client.query(
        `INSERT INTO wallet_balances
          (location_id, location_name, current_balance_php, current_month, total_topup_php, total_usage_php, total_usage_usd, last_updated)
         VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
         ON CONFLICT (location_id) DO UPDATE SET
          location_name = EXCLUDED.location_name,
          current_balance_php = $3,
          current_month = $4,
          total_topup_php = $5,
          total_usage_php = $6,
          total_usage_usd = $7,
          last_updated = NOW()`,
        [
          loc.locationId, loc.locationName, newBalance, currentMonth(),
          parseFloat(totalTopup.rows[0].total),
          parseFloat(totalUsage.rows[0].total),
          parseFloat(totalUsageUsd.rows[0].total),
        ]
      );
    }

    await client.query('COMMIT');
    res.json({ success: true, synced: locations.length });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('[sync-usage] error:', e.message);
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

module.exports = router;

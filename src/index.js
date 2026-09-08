require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { initDB } = require('./db');
const { getData, initialize, scheduleAutoRefresh, submitOtp, isAwaitingOtp } = require('./scraper');
const walletPHPRouter = require('./routes/walletPHP');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'snbx-billing-api', ts: new Date().toISOString() });
});

app.get('/api/status', (req, res) => {
  res.json({ awaitingOtp: isAwaitingOtp(), ts: new Date().toISOString() });
});

app.post('/api/otp', (req, res) => {
  const { code } = req.body;
  if (!code) return res.status(400).json({ error: 'Missing code' });
  try {
    submitOtp(String(code).trim());
    res.json({ success: true, message: 'OTP submitted — scraping in progress' });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.get('/api/wallet', async (req, res) => {
  if (isAwaitingOtp()) return res.status(202).json({ error: 'awaiting_otp' });
  try {
    const data = await getData();
    if (!data.wallet) return res.status(503).json({ error: 'Data not yet available' });
    res.json({ success: true, ...data.wallet });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/ai', async (req, res) => {
  if (isAwaitingOtp()) return res.status(202).json({ error: 'awaiting_otp' });
  try {
    const data = await getData();
    if (!data.ai) return res.status(503).json({ error: 'Data not yet available' });
    res.json({ success: true, ...data.ai });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/refresh', async (req, res) => {
  res.json({ success: true, message: 'Refresh queued' });
  try {
    // Force bust the cache
    const scraper = require('./scraper');
    if (scraper.cache) {
      scraper.cache.lastScraped = null;
      scraper.cache.wallet = null;
      scraper.cache.ai = null;
    }
    console.log('[refresh] Cache busted — starting fresh scrape');
    const data = await getData();
    await syncUsageToDB(data);
    console.log('[refresh] Complete');
  } catch (e) {
    console.error('[refresh] failed:', e.message);
  }
});

// PHP peso wallet routes
app.use('/api/php', walletPHPRouter);

// Clear saved session and force fresh login + OTP
app.post('/api/debug/clear-session', (req, res) => {
  const fs = require('fs');
  const sessionPath = '/tmp/ghl-session.json';
  try {
    if (fs.existsSync(sessionPath)) {
      fs.unlinkSync(sessionPath);
      console.log('[debug] Session file cleared');
    }
    // Also bust scrape cache
    const scraper = require('./scraper');
    if (scraper.cache) scraper.cache.lastScraped = null;
    res.json({ success: true, message: 'Session cleared — next scrape will trigger fresh login and OTP' });
    // Trigger fresh scrape in background
    setTimeout(() => {
      getData().catch(e => console.error('[debug] Fresh scrape failed:', e.message));
    }, 1000);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Debug sync — shows what would be synced without writing to DB
app.get('/api/debug/sync-preview', async (req, res) => {
  try {
    const data = require('./scraper').cache;
    if (!data?.wallet?.data?.length) return res.status(503).json({ error: 'No cached data yet' });

    const curMonth = new Date();
    const monthKey = curMonth.getFullYear() + '-' + String(curMonth.getMonth()+1).padStart(2,'0');
    const BILLING_START = '2026-09';
    const isBillingMonth = monthKey >= BILLING_START;
    const USD_TO_PHP = parseFloat(process.env.USD_TO_PHP_RATE || '58');
    const MARKUP = 1.5;

    const aiMap = {};
    if (data.ai?.data?.length) {
      data.ai.data.forEach(l => { aiMap[l.locationId] = l.totalGrossCharge || 0; });
    }

    const preview = data.wallet.data.slice(0, 10).map(loc => {
      const walletThisMonth = parseFloat(loc.months?.[monthKey]?.amount || 0);
      const aiThisMonth = parseFloat(aiMap[loc.locationId] || 0);
      const usageUsd = isBillingMonth ? walletThisMonth + aiThisMonth : 0;
      const usagePhp = parseFloat((usageUsd * MARKUP * USD_TO_PHP).toFixed(2));
      return {
        name: loc.locationName,
        monthKey,
        isBillingMonth,
        walletThisMonth,
        aiThisMonth,
        usageUsd,
        usagePhp,
      };
    });

    res.json({ monthKey, isBillingMonth, billingStart: BILLING_START, preview });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/debug/screenshot', (req, res) => {
  const fs = require('fs');
  const p = '/tmp/login-page.png';
  if (fs.existsSync(p)) {
    res.setHeader('Content-Type', 'image/png');
    fs.createReadStream(p).pipe(res);
  } else {
    res.status(404).json({ error: 'No screenshot yet' });
  }
});

app.use((req, res) => res.status(404).json({ error: 'Route not found' }));
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: err.message });
});

async function syncUsageToDB(data) {
  if (!data?.wallet?.data?.length) return;
  try {
    // Build AI usage map by locationId for current month
    const aiMap = {};
    if (data.ai?.data?.length) {
      data.ai.data.forEach(l => { aiMap[l.locationId] = l.totalGrossCharge || 0; });
    }

    const locations = data.wallet.data.map(loc => ({
      locationId: loc.locationId,
      locationName: loc.locationName,
      months: loc.months || {},
      aiUsageThisMonth: aiMap[loc.locationId] || 0,
    }));

    const fetch = require('node-fetch');
    const res = await fetch(`http://localhost:${PORT}/api/php/sync-usage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ locations }),
    });
    const result = await res.json();
    console.log('[sync] Usage synced:', result.synced, 'locations, billing active:', result.billingActive);
  } catch (e) {
    console.error('[sync] Failed:', e.message);
  }
}

async function startServer() {
  try {
    await initDB();
    console.log('[db] PostgreSQL connected');
  } catch (e) {
    console.error('[db] Connection failed:', e.message);
  }

  app.listen(PORT, async () => {
    console.log(`SNBX Billing API running on port ${PORT}`);
    scheduleAutoRefresh();
    initialize().then(async (data) => {
      if (data) await syncUsageToDB(data);
    }).catch(e => console.error('[startup] failed:', e.message));
  });
}

startServer();

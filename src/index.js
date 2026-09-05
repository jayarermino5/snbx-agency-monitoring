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
    const scraper = require('./scraper');
    if (scraper.cache) scraper.cache.lastScraped = null;
    const data = await getData();
    await syncUsageToDB(data);
  } catch (e) {
    console.error('[refresh] failed:', e.message);
  }
});

// PHP peso wallet routes
app.use('/api/php', walletPHPRouter);

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
    const locations = data.wallet.data.map(loc => {
      const totalUsd = Object.values(loc.months || {})
        .reduce((sum, m) => sum + (m.amount || 0), 0);
      return { locationId: loc.locationId, locationName: loc.locationName, totalUsageUsd: totalUsd };
    });

    if (data.ai?.data?.length) {
      const aiMap = {};
      data.ai.data.forEach(l => { aiMap[l.locationId] = l.totalGrossCharge || 0; });
      locations.forEach(loc => { loc.totalUsageUsd += (aiMap[loc.locationId] || 0); });
    }

    if (!locations.length) {
      console.log('[sync] No locations to sync');
      return;
    }

    const fetch = require('node-fetch');
    const res = await fetch(`http://localhost:${PORT}/api/php/sync-usage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ locations }),
    });
    const result = await res.json();
    console.log('[sync] Usage synced:', result.synced, 'locations');
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

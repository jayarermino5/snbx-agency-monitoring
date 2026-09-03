require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { getData, initialize, scheduleAutoRefresh, submitOtp, isAwaitingOtp } = require('./scraper');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'snbx-billing-api', ts: new Date().toISOString() });
});

// Status — shows if OTP is needed
app.get('/api/status', (req, res) => {
  res.json({
    awaitingOtp: isAwaitingOtp(),
    cacheReady: !!(require('./scraper').getData),
    ts: new Date().toISOString(),
  });
});

// Submit OTP code
app.post('/api/otp', (req, res) => {
  const { code } = req.body;
  if (!code) return res.status(400).json({ error: 'Missing code in request body' });
  try {
    submitOtp(String(code).trim());
    res.json({ success: true, message: 'OTP submitted — scraping in progress' });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Wallet data
app.get('/api/wallet', async (req, res) => {
  if (isAwaitingOtp()) {
    return res.status(202).json({
      error: 'awaiting_otp',
      message: 'OTP verification required. Submit code to POST /api/otp',
    });
  }
  try {
    const data = await getData();
    if (!data.wallet) return res.status(503).json({ error: 'Wallet data not yet available' });
    res.json({ success: true, ...data.wallet });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// AI data
app.get('/api/ai', async (req, res) => {
  if (isAwaitingOtp()) {
    return res.status(202).json({
      error: 'awaiting_otp',
      message: 'OTP verification required. Submit code to POST /api/otp',
    });
  }
  try {
    const data = await getData();
    if (!data.ai) return res.status(503).json({ error: 'AI data not yet available' });
    res.json({ success: true, ...data.ai });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Force re-scrape
app.post('/api/refresh', async (req, res) => {
  try {
    const scraper = require('./scraper');
    scraper.cache && (scraper.cache.lastScraped = null);
    res.json({ success: true, message: 'Refresh queued' });
    getData().catch(e => console.error('[refresh] failed:', e.message));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Screenshot debug
app.get('/api/debug/screenshot', (req, res) => {
  const fs = require('fs');
  const path = '/tmp/login-page.png';
  if (fs.existsSync(path)) {
    res.setHeader('Content-Type', 'image/png');
    fs.createReadStream(path).pipe(res);
  } else {
    res.status(404).json({ error: 'No screenshot yet' });
  }
});

app.use((req, res) => res.status(404).json({ error: 'Route not found' }));
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: err.message });
});

app.listen(PORT, async () => {
  console.log(`SNBX Billing API running on port ${PORT}`);
  scheduleAutoRefresh();
  initialize().catch(e => console.error('[startup] init failed:', e.message));
});

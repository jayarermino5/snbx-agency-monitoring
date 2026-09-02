require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { getData, initialize, scheduleAutoRefresh } = require('./scraper');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'snbx-billing-api', ts: new Date().toISOString() });
});

// Wallet sub-account usage
app.get('/api/wallet', async (req, res) => {
  try {
    const data = await getData();
    if (!data.wallet) return res.status(503).json({ error: 'Wallet data not yet available — scrape in progress' });
    res.json({ success: true, ...data.wallet });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// AI Suite usage
app.get('/api/ai', async (req, res) => {
  try {
    const data = await getData();
    if (!data.ai) return res.status(503).json({ error: 'AI data not yet available — scrape in progress' });
    res.json({ success: true, ...data.ai });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Force re-scrape
app.post('/api/refresh', async (req, res) => {
  try {
    const { getData: gd, initialize: init } = require('./scraper');
    // bust cache
    const scraper = require('./scraper');
    scraper._bustCache && scraper._bustCache();
    const data = await getData();
    res.json({ success: true, message: 'Refresh complete', wallet: data.wallet?.data?.length, ai: data.ai?.data?.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
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
  // Pre-warm in background — don't block server startup
  initialize().catch(e => console.error('[startup] init failed:', e.message));
});

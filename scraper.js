const { chromium } = require('playwright');

const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

let cache = {
  wallet: null,
  ai: null,
  lastScraped: null,
};

let scraping = false;
let scrapeQueue = [];

function isCacheFresh() {
  return cache.lastScraped && (Date.now() - cache.lastScraped) < CACHE_TTL_MS;
}

async function scrapeGHL() {
  const email = process.env.GHL_EMAIL;
  const password = process.env.GHL_PASSWORD;
  const domain = process.env.GHL_DOMAIN || 'app.smartfollowups.com';
  const companyId = process.env.GHL_COMPANY_ID;

  if (!email || !password) throw new Error('GHL_EMAIL or GHL_PASSWORD not set');

  console.log('[scraper] Launching browser...');

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });

  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  });

  const page = await context.newPage();

  // Capture API responses in flight
  let walletData = null;
  let aiData = null;

  page.on('response', async (response) => {
    const url = response.url();
    try {
      if (url.includes('blade-platform/warehouse/v2/location-usage-records')) {
        const json = await response.json();
        if (json.success && json.data) {
          // Merge pages — collect all data
          if (!walletData) walletData = { ...json, data: [] };
          walletData.data = walletData.data.concat(json.data);
          console.log(`[scraper] Wallet data: ${walletData.data.length}/${json.locationsCount}`);
        }
      }
      if (url.includes('ai-wrapper/usage/company/locations')) {
        const json = await response.json();
        if (json.status === 'success' && json.data) {
          if (!aiData) aiData = { ...json, data: [] };
          aiData.data = aiData.data.concat(json.data);
          console.log(`[scraper] AI data: ${aiData.data.length}, hasMore: ${json.hasMore}`);
        }
      }
    } catch (e) {
      // not JSON or other error — skip
    }
  });

  try {
    // Step 1: Login
    console.log('[scraper] Navigating to login...');
    await page.goto(`https://${domain}/auth/login`, { waitUntil: 'networkidle', timeout: 60000 });

    // Fill login form
    await page.waitForSelector('input[type="email"], input[name="email"]', { timeout: 15000 });
    await page.fill('input[type="email"], input[name="email"]', email);
    await page.fill('input[type="password"], input[name="password"]', password);
    await page.keyboard.press('Enter');
    console.log('[scraper] Submitted login form...');

    // Wait for dashboard to load
    await page.waitForNavigation({ waitUntil: 'networkidle', timeout: 60000 });
    console.log('[scraper] Logged in, current URL:', page.url());

    // Step 2: Navigate to wallet billing page
    console.log('[scraper] Loading wallet billing page...');
    await page.goto(
      `https://${domain}/settings/billing?tab=wallet_transactions&sub_tab=subs`,
      { waitUntil: 'networkidle', timeout: 60000 }
    );
    // Wait for data to load — scroll triggers pagination
    await page.waitForTimeout(5000);

    // Trigger all pages by scrolling if needed
    let prevCount = 0;
    for (let i = 0; i < 20; i++) {
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await page.waitForTimeout(2000);
      const currentCount = walletData?.data?.length || 0;
      if (currentCount === prevCount && currentCount > 0) break;
      prevCount = currentCount;
    }

    console.log('[scraper] Wallet done, total:', walletData?.data?.length);

    // Step 3: Navigate to AI Suite page
    console.log('[scraper] Loading AI Suite page...');
    const now = new Date();
    const firstOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().split('T')[0];
    const today = now.toISOString().split('T')[0];

    await page.goto(
      `https://${domain}/ai-suite?view=dashboard&usageProduct=AI_STUDIO&usageSortBy=createdAt&usageSortOrder=desc`,
      { waitUntil: 'networkidle', timeout: 60000 }
    );
    await page.waitForTimeout(5000);

    console.log('[scraper] AI Suite done, total:', aiData?.data?.length);

    cache.wallet = walletData;
    cache.ai = aiData;
    cache.lastScraped = Date.now();

    console.log('[scraper] Scrape complete ✓');
    return cache;

  } finally {
    await browser.close();
    console.log('[scraper] Browser closed');
  }
}

async function getData() {
  if (isCacheFresh()) {
    console.log('[scraper] Returning cached data');
    return cache;
  }

  if (scraping) {
    return new Promise((resolve, reject) => {
      scrapeQueue.push({ resolve, reject });
    });
  }

  scraping = true;
  try {
    const result = await scrapeGHL();
    scrapeQueue.forEach(({ resolve }) => resolve(result));
    return result;
  } catch (err) {
    scrapeQueue.forEach(({ reject }) => reject(err));
    throw err;
  } finally {
    scraping = false;
    scrapeQueue = [];
  }
}

// Pre-warm cache on startup
async function initialize() {
  try {
    console.log('[scraper] Pre-warming cache on startup...');
    await getData();
  } catch (e) {
    console.error('[scraper] Startup scrape failed:', e.message);
  }
}

// Schedule auto-refresh every 55 minutes
function scheduleAutoRefresh() {
  setInterval(async () => {
    if (!isCacheFresh()) {
      console.log('[scraper] Auto-refresh triggered');
      try { await getData(); } catch (e) {
        console.error('[scraper] Auto-refresh failed:', e.message);
      }
    }
  }, 55 * 60 * 1000);
}

module.exports = { getData, initialize, scheduleAutoRefresh };

const { chromium } = require('playwright');

const CACHE_TTL_MS = 60 * 60 * 1000;

let cache = { wallet: null, ai: null, lastScraped: null };
let scraping = false;
let scrapeQueue = [];

function isCacheFresh() {
  return cache.lastScraped && (Date.now() - cache.lastScraped) < CACHE_TTL_MS;
}

async function scrapeGHL() {
  const email = process.env.GHL_EMAIL;
  const password = process.env.GHL_PASSWORD;
  const domain = process.env.GHL_DOMAIN || 'app.smartfollowups.com';

  if (!email || !password) throw new Error('GHL_EMAIL or GHL_PASSWORD not set');

  console.log('[scraper] Launching browser...');
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });

  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    extraHTTPHeaders: { 'Accept-Language': 'en-US,en;q=0.9' },
  });

  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    window.chrome = { runtime: {} };
  });

  const page = await context.newPage();
  let walletData = null;
  let aiData = null;

  page.on('response', async (response) => {
    const url = response.url();
    try {
      if (url.includes('blade-platform/warehouse/v2/location-usage-records')) {
        const json = await response.json();
        if (json.success && json.data) {
          if (!walletData) walletData = { ...json, data: [] };
          walletData.data = walletData.data.concat(json.data);
          console.log(`[scraper] Wallet: ${walletData.data.length}/${json.locationsCount}`);
        }
      }
      if (url.includes('ai-wrapper/usage/company/locations')) {
        const json = await response.json();
        if (json.status === 'success' && json.data) {
          if (!aiData) aiData = { ...json, data: [] };
          aiData.data = aiData.data.concat(json.data);
          console.log(`[scraper] AI: ${aiData.data.length}, hasMore: ${json.hasMore}`);
        }
      }
    } catch (e) {}
  });

  try {
    console.log('[scraper] Navigating to login...');
    await page.goto(`https://${domain}`, {
      waitUntil: 'networkidle',
      timeout: 60000,
    });

    await page.waitForTimeout(3000);
    console.log('[scraper] URL:', page.url());

    // Wait for the email input — we know the placeholder
    await page.waitForSelector('input[placeholder="Your email address"]', { timeout: 15000 });
    console.log('[scraper] Login form ready');

    // Fill email
    await page.fill('input[placeholder="Your email address"]', email);
    console.log('[scraper] Filled email');
    await page.waitForTimeout(500);

    // Fill password
    await page.fill('input[placeholder="The password you picked"]', password);
    console.log('[scraper] Filled password');
    await page.waitForTimeout(500);

    // Click Sign in button
    await page.click('button:has-text("Sign in")');
    console.log('[scraper] Clicked Sign in');

    // Wait for post-login — either redirect or dashboard load
    await page.waitForTimeout(8000);
    console.log('[scraper] Post-login URL:', page.url());

    // Take screenshot to confirm login
    await page.screenshot({ path: '/tmp/post-login.png', fullPage: false });

    // Check if still on login page (failed login)
    if (page.url().includes('auth/login') || page.url() === `https://${domain}/`) {
      const errorText = await page.evaluate(() => document.body.innerText.slice(0, 300));
      throw new Error(`Login may have failed. Page text: ${errorText}`);
    }

    // Navigate to wallet billing page
    console.log('[scraper] Loading wallet page...');
    await page.goto(
      `https://${domain}/settings/billing?tab=wallet_transactions&sub_tab=subs`,
      { waitUntil: 'networkidle', timeout: 60000 }
    );
    await page.waitForTimeout(5000);

    for (let i = 0; i < 15; i++) {
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await page.waitForTimeout(2000);
      if (walletData?.data?.length >= (walletData?.locationsCount || 99)) break;
    }
    console.log('[scraper] Wallet done:', walletData?.data?.length);

    // Navigate to AI Suite page
    console.log('[scraper] Loading AI Suite page...');
    await page.goto(
      `https://${domain}/ai-suite?view=dashboard&usageProduct=AI_STUDIO&usageSortBy=createdAt&usageSortOrder=desc`,
      { waitUntil: 'networkidle', timeout: 60000 }
    );
    await page.waitForTimeout(5000);
    console.log('[scraper] AI done:', aiData?.data?.length);

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

async function initialize() {
  try {
    console.log('[scraper] Pre-warming cache on startup...');
    await getData();
  } catch (e) {
    console.error('[scraper] Startup scrape failed:', e.message);
  }
}

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

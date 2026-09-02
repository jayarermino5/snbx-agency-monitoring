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
    } catch (e) {}
  });

  try {
    // Navigate to login
    console.log('[scraper] Navigating to login...');
    await page.goto(`https://${domain}/auth/login`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(3000);

    // Debug info
    console.log('[scraper] URL:', page.url());
    console.log('[scraper] Title:', await page.title());

    // Log all inputs for debugging
    const inputs = await page.evaluate(() =>
      Array.from(document.querySelectorAll('input')).map(i => ({
        type: i.type, name: i.name, id: i.id,
        placeholder: i.placeholder, class: i.className.slice(0, 60)
      }))
    );
    console.log('[scraper] Inputs found:', JSON.stringify(inputs));

    // Try all possible email selectors
    const emailSel = await page.evaluate(() => {
      const candidates = [
        'input[type="email"]', 'input[name="email"]',
        'input[placeholder*="email" i]', 'input#email',
        'input[autocomplete="email"]', 'input[autocomplete="username"]',
      ];
      for (const s of candidates) {
        if (document.querySelector(s)) return s;
      }
      // fallback: first visible text/email input
      const all = document.querySelectorAll('input:not([type="hidden"])');
      if (all.length > 0) return `input:nth-of-type(${Array.from(document.querySelectorAll('input')).indexOf(all[0]) + 1})`;
      return null;
    });

    console.log('[scraper] Email selector found:', emailSel);
    if (!emailSel) throw new Error('No email input found on login page');

    await page.fill(emailSel, email);
    await page.waitForTimeout(500);

    const passSel = await page.evaluate(() => {
      const candidates = [
        'input[type="password"]', 'input[name="password"]',
        'input[placeholder*="password" i]', 'input#password',
      ];
      for (const s of candidates) {
        if (document.querySelector(s)) return s;
      }
      return null;
    });

    console.log('[scraper] Password selector found:', passSel);
    if (!passSel) throw new Error('No password input found on login page');

    await page.fill(passSel, password);
    await page.waitForTimeout(500);
    await page.keyboard.press('Enter');
    console.log('[scraper] Submitted login form...');

    // Wait for navigation after login
    await page.waitForTimeout(8000);
    console.log('[scraper] Post-login URL:', page.url());

    // Navigate to wallet billing page
    console.log('[scraper] Loading wallet billing page...');
    await page.goto(
      `https://${domain}/settings/billing?tab=wallet_transactions&sub_tab=subs`,
      { waitUntil: 'networkidle', timeout: 60000 }
    );
    await page.waitForTimeout(5000);

    // Scroll to trigger pagination
    for (let i = 0; i < 15; i++) {
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await page.waitForTimeout(2000);
      if (walletData?.data?.length >= (walletData?.locationsCount || 99)) break;
    }
    console.log('[scraper] Wallet done, total:', walletData?.data?.length);

    // Navigate to AI Suite page
    console.log('[scraper] Loading AI Suite page...');
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

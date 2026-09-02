const { chromium } = require('playwright');
const fs = require('fs');

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
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled',
    ],
  });

  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    // Spoof webdriver flag
    extraHTTPHeaders: {
      'Accept-Language': 'en-US,en;q=0.9',
    },
  });

  // Hide automation flags
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3] });
    Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
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
    const response = await page.goto(`https://${domain}/auth/login`, {
      waitUntil: 'networkidle',
      timeout: 60000,
    });

    console.log('[scraper] HTTP status:', response?.status());
    console.log('[scraper] URL:', page.url());
    console.log('[scraper] Title:', await page.title());

    // Wait longer for JS to boot
    await page.waitForTimeout(8000);

    // Get full page HTML snippet for debugging
    const bodyHTML = await page.evaluate(() => document.body?.innerHTML?.slice(0, 500) || 'EMPTY');
    console.log('[scraper] Body HTML snippet:', bodyHTML);

    // Get all inputs
    const inputs = await page.evaluate(() =>
      Array.from(document.querySelectorAll('input')).map(i => ({
        type: i.type, name: i.name, id: i.id, placeholder: i.placeholder,
      }))
    );
    console.log('[scraper] Inputs found:', JSON.stringify(inputs));

    // Take screenshot and save to /tmp
    await page.screenshot({ path: '/tmp/login-page.png', fullPage: true });
    console.log('[scraper] Screenshot saved to /tmp/login-page.png');

    if (inputs.length === 0) {
      throw new Error('Page rendered no inputs — possible bot detection or blank page. Check HTML snippet in logs.');
    }

    // Fill email
    const emailInput = await page.$('input[type="email"]') ||
      await page.$('input[name="email"]') ||
      await page.$('input[placeholder*="email" i]') ||
      (await page.$$('input:not([type="hidden"])'))[0];

    if (!emailInput) throw new Error('No email input found');
    await emailInput.fill(email);
    console.log('[scraper] Filled email');
    await page.waitForTimeout(500);

    const passwordInput = await page.$('input[type="password"]') ||
      await page.$('input[name="password"]') ||
      (await page.$$('input:not([type="hidden"])'))[1];

    if (!passwordInput) throw new Error('No password input found');
    await passwordInput.fill(password);
    console.log('[scraper] Filled password');
    await page.waitForTimeout(500);

    const submitBtn = await page.$('button[type="submit"]') ||
      await page.$('button:has-text("Sign in")') ||
      await page.$('button:has-text("Login")') ||
      await page.$('button:has-text("Log in")');

    if (submitBtn) {
      await submitBtn.click();
      console.log('[scraper] Clicked submit');
    } else {
      await page.keyboard.press('Enter');
      console.log('[scraper] Pressed Enter');
    }

    await page.waitForURL(`https://${domain}/**`, { timeout: 30000 });
    await page.waitForTimeout(3000);
    console.log('[scraper] Logged in. URL:', page.url());

    // Wallet page
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

    // AI Suite page
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

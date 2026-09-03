const { chromium } = require('playwright');

const CACHE_TTL_MS = 60 * 60 * 1000;

let cache = { wallet: null, ai: null, lastScraped: null };
let scraping = false;
let scrapeQueue = [];

// OTP state — holds resolve/reject while waiting for user input
let otpResolver = null;
let otpRejecter = null;
let awaitingOtp = false;

function isCacheFresh() {
  return cache.lastScraped && (Date.now() - cache.lastScraped) < CACHE_TTL_MS;
}

// Called by the /api/otp route when user submits the code
function submitOtp(code) {
  if (otpResolver) {
    console.log('[scraper] OTP received:', code);
    awaitingOtp = false;
    otpResolver(code);
    otpResolver = null;
    otpRejecter = null;
  } else {
    throw new Error('No OTP prompt is currently active');
  }
}

function isAwaitingOtp() {
  return awaitingOtp;
}

// Returns a promise that resolves when OTP is submitted via API
function waitForOtp() {
  awaitingOtp = true;
  console.log('[scraper] Waiting for OTP from user...');
  return new Promise((resolve, reject) => {
    otpResolver = resolve;
    otpRejecter = reject;
    // Timeout after 10 minutes
    setTimeout(() => {
      if (otpRejecter) {
        awaitingOtp = false;
        otpRejecter(new Error('OTP timeout — no code submitted within 10 minutes'));
        otpResolver = null;
        otpRejecter = null;
      }
    }, 10 * 60 * 1000);
  });
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

  // Deduplicate by locationId
  function mergeByLocationId(existing, incoming) {
    const map = new Map((existing || []).map(l => [l.locationId, l]));
    for (const loc of incoming) map.set(loc.locationId, loc);
    return Array.from(map.values());
  }

  page.on('response', async (response) => {
    const url = response.url();
    try {
      if (url.includes('blade-platform/warehouse/v2/location-usage-records')) {
        const json = await response.json();
        if (json.success && json.data) {
          if (!walletData) walletData = { ...json, data: [] };
          walletData.data = mergeByLocationId(walletData.data, json.data);
          walletData.locationsCount = json.locationsCount;
          console.log(`[scraper] Wallet: ${walletData.data.length}/${json.locationsCount}`);
        }
      }
      if (url.includes('ai-wrapper/usage/company/locations')) {
        const json = await response.json();
        if (json.status === 'success' && json.data) {
          if (!aiData) aiData = { ...json, data: [] };
          aiData.data = mergeByLocationId(aiData.data, json.data);
          console.log(`[scraper] AI: ${aiData.data.length}, hasMore: ${json.hasMore}`);
        }
      }
    } catch (e) {}
  });

  try {
    console.log('[scraper] Navigating to login...');
    await page.goto(`https://${domain}`, { waitUntil: 'networkidle', timeout: 60000 });
    await page.waitForTimeout(3000);

    await page.waitForSelector('input[placeholder="Your email address"]', { timeout: 15000 });
    console.log('[scraper] Login form ready');

    await page.fill('input[placeholder="Your email address"]', email);
    await page.waitForTimeout(500);
    await page.fill('input[placeholder="The password you picked"]', password);
    await page.waitForTimeout(500);
    await page.click('button:has-text("Sign in")');
    console.log('[scraper] Clicked Sign in');

    // Wait to see what happens next
    await page.waitForTimeout(5000);
    const postLoginUrl = page.url();
    const pageText = await page.evaluate(() => document.body.innerText.slice(0, 200));
    console.log('[scraper] Post-login URL:', postLoginUrl);
    console.log('[scraper] Post-login text:', pageText.slice(0, 100));

    // Check if OTP is required
    const needsOtp = pageText.includes('Security Code') ||
      pageText.includes('security code') ||
      pageText.includes('OTP') ||
      pageText.includes('Verify');

    if (needsOtp) {
      console.log('[scraper] OTP required — waiting for user to submit code via /api/otp');

      // Wait for OTP from the API endpoint
      const otp = await waitForOtp();

      // Find OTP inputs — GHL uses individual digit boxes or a single input
      const otpInputs = await page.$$('input[type="text"], input[type="number"], input[type="tel"]');
      console.log('[scraper] OTP input count:', otpInputs.length);

      if (otpInputs.length >= 4) {
        // Individual digit boxes
        const digits = otp.replace(/\D/g, '').split('');
        for (let i = 0; i < Math.min(digits.length, otpInputs.length); i++) {
          await otpInputs[i].fill(digits[i]);
          await page.waitForTimeout(100);
        }
        console.log('[scraper] Filled OTP digits');
      } else if (otpInputs.length === 1) {
        await otpInputs[0].fill(otp);
        console.log('[scraper] Filled OTP single input');
      } else {
        // Try typing into focused element
        await page.keyboard.type(otp);
        console.log('[scraper] Typed OTP via keyboard');
      }

      await page.waitForTimeout(500);

      // Click verify/confirm button
      const verifyBtn = await page.$('button:has-text("Verify")') ||
        await page.$('button:has-text("Confirm")') ||
        await page.$('button:has-text("Submit")') ||
        await page.$('button[type="submit"]');

      if (verifyBtn) {
        await verifyBtn.click();
        console.log('[scraper] Clicked verify button');
      } else {
        await page.keyboard.press('Enter');
        console.log('[scraper] Pressed Enter to verify');
      }

      await page.waitForTimeout(5000);
      console.log('[scraper] Post-OTP URL:', page.url());
    }

    // Confirm we're logged in
    const finalUrl = page.url();
    if (finalUrl.includes('auth') || finalUrl === `https://${domain}/`) {
      const text = await page.evaluate(() => document.body.innerText.slice(0, 300));
      throw new Error(`Still not logged in after OTP. URL: ${finalUrl}. Text: ${text}`);
    }

    console.log('[scraper] Logged in successfully ✓');

    // Wallet page
    console.log('[scraper] Loading wallet page...');
    await page.goto(
      `https://${domain}/settings/billing?tab=wallet_transactions&sub_tab=subs`,
      { waitUntil: 'domcontentloaded', timeout: 60000 }
    );
    await page.waitForTimeout(8000);

    for (let i = 0; i < 15; i++) {
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await page.waitForTimeout(2000);
      if (walletData?.data?.length >= (walletData?.locationsCount || 99)) break;
    }
    console.log('[scraper] Wallet done:', walletData?.data?.length);

    // AI Suite page
    console.log('[scraper] Loading AI Suite page...');
    try {
      await page.goto(
        `https://${domain}/ai-suite?view=dashboard&usageProduct=AI_STUDIO&usageSortBy=createdAt&usageSortOrder=desc`,
        { waitUntil: 'domcontentloaded', timeout: 60000 }
      );
      await page.waitForTimeout(8000);
      console.log('[scraper] AI done:', aiData?.data?.length);
    } catch (e) {
      console.warn('[scraper] AI Suite page failed (non-fatal):', e.message);
    }

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

module.exports = { getData, initialize, scheduleAutoRefresh, submitOtp, isAwaitingOtp };

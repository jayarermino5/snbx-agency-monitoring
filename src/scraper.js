const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const CACHE_TTL_MS = 55 * 60 * 1000;
const SESSION_PATH = '/tmp/ghl-session.json';

let cache = { wallet: null, ai: null, lastScraped: null };
let scraping = false;
let scrapeQueue = [];
let otpResolver = null;
let otpRejecter = null;
let awaitingOtp = false;

function isCacheFresh() {
  return cache.lastScraped && (Date.now() - cache.lastScraped) < CACHE_TTL_MS;
}

function submitOtp(code) {
  if (otpResolver) {
    console.log('[scraper] OTP received');
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

function waitForOtp() {
  awaitingOtp = true;
  console.log('[scraper] Waiting for OTP from user...');
  return new Promise((resolve, reject) => {
    otpResolver = resolve;
    otpRejecter = reject;
    setTimeout(() => {
      if (otpRejecter) {
        awaitingOtp = false;
        otpRejecter(new Error('OTP timeout'));
        otpResolver = null;
        otpRejecter = null;
      }
    }, 10 * 60 * 1000);
  });
}

function sessionExists() {
  try {
    return fs.existsSync(SESSION_PATH) &&
      JSON.parse(fs.readFileSync(SESSION_PATH, 'utf8'))?.cookies?.length > 0;
  } catch (e) {
    return false;
  }
}

async function saveSession(context) {
  try {
    const storage = await context.storageState();
    fs.writeFileSync(SESSION_PATH, JSON.stringify(storage));
    console.log('[scraper] Session saved to', SESSION_PATH);
  } catch (e) {
    console.warn('[scraper] Failed to save session:', e.message);
  }
}

function clearSession() {
  try {
    if (fs.existsSync(SESSION_PATH)) {
      fs.unlinkSync(SESSION_PATH);
      console.log('[scraper] Session cleared');
    }
  } catch (e) {}
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
      '--disable-gpu',
      '--no-zygote',
      '--single-process',
      '--disable-extensions',
      '--disable-background-networking',
      '--disable-default-apps',
      '--disable-sync',
      '--disable-translate',
      '--hide-scrollbars',
      '--metrics-recording-only',
      '--mute-audio',
      '--no-first-run',
      '--safebrowsing-disable-auto-update',
      '--js-flags=--max-old-space-size=256',
    ],
  });

  // Load saved session if available
  const hasSavedSession = sessionExists();
  console.log('[scraper] Saved session found:', hasSavedSession);

  const contextOptions = {
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    extraHTTPHeaders: { 'Accept-Language': 'en-US,en;q=0.9' },
  };

  if (hasSavedSession) {
    contextOptions.storageState = SESSION_PATH;
  }

  const context = await browser.newContext(contextOptions);

  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    window.chrome = { runtime: {} };
  });

  const page = await context.newPage();
  let walletData = null;
  let aiData = null;

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
          // Log full structure of first record so we know field names
          if (aiData.data.length > 0 && aiData.data.length <= json.data.length) {
            console.log('[scraper] AI record sample:', JSON.stringify(aiData.data[0]).slice(0, 300));
          }
          console.log(`[scraper] AI: ${aiData.data.length}, hasMore: ${json.hasMore}`);
        }
      }
    } catch (e) {}
  });

  try {
    console.log('[scraper] Navigating to GHL...');
    await page.goto(`https://${domain}`, { waitUntil: 'networkidle', timeout: 60000 });
    await page.waitForTimeout(3000);

    const currentUrl = page.url();
    console.log('[scraper] Current URL:', currentUrl);

    // Check if already logged in via saved session
    // GHL can land on root domain after login so check page content too
    const pageText = await page.evaluate(() => document.body?.innerText?.slice(0, 300) || '');
    const isOnLoginPage = currentUrl.includes('/auth/') ||
      pageText.includes('Sign into your account') ||
      pageText.includes('Your email address');
    const isLoggedIn = !isOnLoginPage;

    if (!isLoggedIn) {
      console.log('[scraper] Not logged in — starting login flow...');

      // Wait for login form
      await page.waitForSelector('input[placeholder="Your email address"]', { timeout: 15000 });
      await page.fill('input[placeholder="Your email address"]', email);
      await page.waitForTimeout(500);
      await page.fill('input[placeholder="The password you picked"]', password);
      await page.waitForTimeout(500);
      await page.click('button:has-text("Sign in")');
      console.log('[scraper] Clicked Sign in');

      await page.waitForTimeout(5000);
      const postLoginUrl = page.url();
      const pageText = await page.evaluate(() => document.body.innerText.slice(0, 300));
      console.log('[scraper] Post-login URL:', postLoginUrl);

      // Check if OTP needed
      const needsOtp = pageText.includes('Security Code') ||
        pageText.includes('security code') ||
        pageText.includes('Verify') ||
        pageText.includes('OTP');

      if (needsOtp) {
        console.log('[scraper] OTP required');

        // Try to check "Trust this device" checkbox if present
        try {
          const trustCheckbox = await page.$('input[type="checkbox"]');
          if (trustCheckbox) {
            await trustCheckbox.check();
            console.log('[scraper] Checked "Trust this device"');
          }
        } catch (e) {}

        // Wait for OTP from user
        const otp = await waitForOtp();

        // Fill OTP — handle both digit boxes and single input
        const otpInputs = await page.$$('input[type="text"], input[type="number"], input[type="tel"]');
        console.log('[scraper] OTP inputs found:', otpInputs.length);

        if (otpInputs.length >= 4) {
          const digits = otp.replace(/\D/g, '').split('');
          for (let i = 0; i < Math.min(digits.length, otpInputs.length); i++) {
            await otpInputs[i].fill(digits[i]);
            await page.waitForTimeout(100);
          }
        } else if (otpInputs.length === 1) {
          await otpInputs[0].fill(otp);
        } else {
          await page.keyboard.type(otp);
        }

        await page.waitForTimeout(500);

        // Try to check trust device again after OTP entry
        try {
          const trustCheckbox = await page.$('input[type="checkbox"]:not(:checked)');
          if (trustCheckbox) {
            await trustCheckbox.check();
            console.log('[scraper] Checked trust device after OTP');
          }
        } catch (e) {}

        // Submit OTP
        const verifyBtn = await page.$('button:has-text("Verify")') ||
          await page.$('button:has-text("Confirm")') ||
          await page.$('button:has-text("Submit")') ||
          await page.$('button[type="submit"]');

        if (verifyBtn) {
          await verifyBtn.click();
        } else {
          await page.keyboard.press('Enter');
        }

        await page.waitForTimeout(5000);
        console.log('[scraper] Post-OTP URL:', page.url());
      }

      // Save session after successful login so we never need OTP again
      await saveSession(context);
      console.log('[scraper] Session saved — future scrapes will skip login');
    } else {
      console.log('[scraper] Using saved session — skipping login ✓');
      // Refresh session file to keep it current
      await saveSession(context);
    }

    // Verify we're actually logged in by checking page content
    const finalUrl = page.url();
    const pageContent = await page.evaluate(() => document.body?.innerText?.slice(0, 100) || '');
    const isOnAuthPage = finalUrl.includes('/auth/') || 
      pageContent.includes('Sign into your account') ||
      pageContent.includes('Your email address');
    if (isOnAuthPage) {
      console.warn('[scraper] Still on auth page — clearing session and will retry');
      clearSession();
      throw new Error('Still on login page after auth — session cleared');
    }
    console.log('[scraper] Login verified, URL:', finalUrl);

    // Wallet page
    console.log('[scraper] Loading wallet page...');
    await page.goto(
      `https://${domain}/settings/billing?tab=wallet_transactions&sub_tab=subs`,
      { waitUntil: 'domcontentloaded', timeout: 60000 }
    );
    // Wait for initial data load
    await page.waitForTimeout(10000);
    console.log('[scraper] Wallet initial load done, captured so far:', walletData?.data?.length);

    // Scroll to trigger pagination — keep scrolling until all loaded
    for (let i = 0; i < 20; i++) {
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await page.waitForTimeout(3000);
      const count = walletData?.data?.length || 0;
      const total = walletData?.locationsCount || 99;
      console.log(`[scraper] Wallet scroll ${i+1}: ${count}/${total}`);
      if (count >= total) break;
    }
    console.log('[scraper] Wallet done:', walletData?.data?.length);

    // AI Suite — fetch API directly from browser context (avoids heavy page load)
    console.log('[scraper] Fetching AI Suite data via API...');
    try {
      const now = new Date();
      const startDate = new Date(now.getFullYear(), now.getMonth() - 5, 1).toISOString().split('T')[0];
      const endDate = now.toISOString().split('T')[0];
      const companyId = process.env.GHL_COMPANY_ID;

      let skip = 0;
      const limit = 100;
      aiData = { status: 'success', data: [] };

      while (true) {
        const apiUrl = `https://services.leadconnectorhq.com/ai-wrapper/usage/company/locations?companyId=${companyId}&startDate=${startDate}&endDate=${endDate}&skip=${skip}&limit=${limit}`;
        const result = await page.evaluate(async (url) => {
          // Get token-id from localStorage/sessionStorage if available
          let tokenId = '';
          try {
            for (let i = 0; i < localStorage.length; i++) {
              const key = localStorage.key(i);
              const val = localStorage.getItem(key);
              if (val && val.startsWith('eyJ') && val.length > 100) {
                tokenId = val;
                break;
              }
            }
          } catch(e) {}

          const res = await fetch(url, {
            headers: {
              'version': '2021-07-28',
              'channel': 'APP',
              'source': 'WEB_USER',
              'source-id': 'blade-platform',
              ...(tokenId ? { 'token-id': tokenId } : {}),
            }
          });
          return res.json();
        }, apiUrl);

        if (result.status !== 'success' || !result.data) {
          console.warn('[scraper] AI API returned:', JSON.stringify(result).slice(0, 200));
          break;
        }

        const incoming = result.data;
        const map = new Map(aiData.data.map(l => [l.locationId, l]));
        for (const loc of incoming) map.set(loc.locationId, loc);
        aiData.data = Array.from(map.values());

        console.log(`[scraper] AI: ${aiData.data.length}, hasMore: ${result.hasMore}`);
        if (!result.hasMore || incoming.length < limit) break;
        skip += limit;
      }

      console.log('[scraper] AI done:', aiData.data.length);
    } catch (e) {
      console.warn('[scraper] AI Suite fetch failed (non-fatal):', e.message);
    }

    // Update session after full scrape
    await saveSession(context);

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
  // Delay startup scrape by 10 seconds to let server fully boot
  await new Promise(r => setTimeout(r, 10000));
  let attempts = 0;
  while (attempts < 3) {
    try {
      console.log('[scraper] Pre-warming cache on startup... attempt', attempts + 1);
      await getData();
      return;
    } catch (e) {
      attempts++;
      console.error('[scraper] Startup scrape failed (attempt ' + attempts + '):', e.message);
      if (attempts < 3) {
        console.log('[scraper] Retrying in 30 seconds...');
        await new Promise(r => setTimeout(r, 30000));
      }
    }
  }
  console.error('[scraper] All startup attempts failed — will retry on next auto-refresh');
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

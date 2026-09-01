const puppeteer = require('puppeteer');

const TOKEN_TTL_MS = 45 * 60 * 1000; // 45 minutes

let cachedToken = null;
let tokenFetchedAt = null;
let refreshing = false;
let refreshQueue = [];

function isTokenFresh() {
  return cachedToken && tokenFetchedAt && (Date.now() - tokenFetchedAt < TOKEN_TTL_MS);
}

async function loginAndGetToken() {
  const email = process.env.GHL_EMAIL;
  const password = process.env.GHL_PASSWORD;
  if (!email || !password) throw new Error('GHL_EMAIL or GHL_PASSWORD not set in environment');

  console.log('[tokenManager] Launching Puppeteer...');

  const browser = await puppeteer.launch({
    headless: "new",
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--no-zygote',
      '--single-process',
    ],
  });

  try {
    const page = await browser.newPage();

    await page.setRequestInterception(true);
    let capturedToken = null;

    page.on('request', (req) => {
      const auth = req.headers()['authorization'];
      if (auth && auth.startsWith('Bearer ') && !capturedToken) {
        const token = auth.replace('Bearer ', '').trim();
        if (token.startsWith('eyJ')) {
          capturedToken = token;
          console.log('[tokenManager] Token captured from request headers');
        }
      }
      req.continue();
    });

    console.log('[tokenManager] Navigating to GHL login...');
    await page.goto('https://app.gohighlevel.com/', { waitUntil: 'networkidle2', timeout: 60000 });

    await page.waitForSelector('input[type="email"], input[name="email"]', { timeout: 15000 });
    await page.type('input[type="email"], input[name="email"]', email, { delay: 50 });
    await page.type('input[type="password"], input[name="password"]', password, { delay: 50 });
    await page.keyboard.press('Enter');

    console.log('[tokenManager] Waiting for post-login navigation...');
    await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 60000 });

    // Wait a bit for XHR calls to fire and capture token
    await new Promise(r => setTimeout(r, 5000));

    // If we didn't capture from headers, try intercepting the billing page
    if (!capturedToken) {
      console.log('[tokenManager] Navigating to billing page to capture token...');
      await page.goto(
        'https://app.smartfollowups.com/settings/billing?tab=wallet_transactions&sub_tab=subs',
        { waitUntil: 'networkidle2', timeout: 60000 }
      );
      await new Promise(r => setTimeout(r, 5000));
    }

    if (!capturedToken) {
      throw new Error('Could not capture Bearer token from GHL session');
    }

    return capturedToken;
  } finally {
    await browser.close();
    console.log('[tokenManager] Browser closed');
  }
}

async function getToken() {
  if (isTokenFresh()) return cachedToken;

  if (refreshing) {
    return new Promise((resolve, reject) => {
      refreshQueue.push({ resolve, reject });
    });
  }

  refreshing = true;
  try {
    console.log('[tokenManager] Refreshing token...');
    const token = await loginAndGetToken();
    cachedToken = token;
    tokenFetchedAt = Date.now();
    console.log('[tokenManager] Token refreshed successfully');

    refreshQueue.forEach(({ resolve }) => resolve(token));
    return token;
  } catch (err) {
    console.error('[tokenManager] Token refresh failed:', err.message);
    refreshQueue.forEach(({ reject }) => reject(err));
    throw err;
  } finally {
    refreshing = false;
    refreshQueue = [];
  }
}

function scheduleAutoRefresh() {
  setInterval(async () => {
    if (!isTokenFresh()) {
      try {
        await getToken();
      } catch (e) {
        console.error('[tokenManager] Auto-refresh failed:', e.message);
      }
    }
  }, 10 * 60 * 1000); // check every 10 min
}

module.exports = { getToken, scheduleAutoRefresh };

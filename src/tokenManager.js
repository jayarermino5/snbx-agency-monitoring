const fetch = require('node-fetch');

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
  const domain = process.env.GHL_DOMAIN || 'app.gohighlevel.com';
  const subdomain = process.env.GHL_SUBDOMAIN || 'app';
  const companyId = process.env.GHL_COMPANY_ID;
  const deviceId = process.env.GHL_DEVICE_ID || 'c1108bc1-400c-49a0-9478-13d8c2314a3a';
  // Any 3 location IDs from your agency — used to get agency-level token
  const locationIds = process.env.GHL_LOCATION_IDS || 'FLZRGfeCUdQxcRE17Wl3,xI7jo1cy8HaLsOy7ML5I,fBmHS43QUr0H51dHbiqr';

  if (!email || !password) {
    throw new Error('GHL_EMAIL or GHL_PASSWORD not set in environment');
  }

  const deviceName = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

  const headers = {
    'Content-Type': 'application/json',
    origin: `https://${domain}`,
    referer: `https://${domain}/`,
    'user-agent': deviceName,
    version: '2021-07-28',
  };

  // Step 1: email/password login — confirms identity
  console.log('[tokenManager] Step 1: email login...');
  const step1Res = await fetch('https://backend.leadconnectorhq.com/oauth/2/login/email', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      email,
      password,
      domain,
      subdomain,
      companyId,
      deviceId,
      deviceName,
      deviceType: 'web',
    }),
  });

  const step1Data = await step1Res.json().catch(() => ({}));
  console.log(`[tokenManager] Step 1 response ${step1Res.status}:`, JSON.stringify(step1Data).slice(0, 200));

  if (!step1Res.ok) {
    throw new Error(`Step 1 failed ${step1Res.status}: ${JSON.stringify(step1Data)}`);
  }

  // Capture cookies from step 1 for step 2
  const setCookie = step1Res.headers.raw()['set-cookie'];
  const cookieHeader = setCookie ? setCookie.map(c => c.split(';')[0]).join('; ') : '';

  // Step 2: signin/refresh — returns the actual JWT
  console.log('[tokenManager] Step 2: signin refresh...');
  const step2Res = await fetch(
    `https://backend.leadconnectorhq.com/oauth/2/login/signin/refresh?version=2&location_id=${locationIds}`,
    {
      method: 'POST',
      headers: {
        ...headers,
        version: '2021-07-28',
        ...(cookieHeader ? { cookie: cookieHeader } : {}),
      },
      body: JSON.stringify({
        email,
        companyId,
        deviceId,
        deviceType: 'web',
      }),
    }
  );

  const step2Data = await step2Res.json().catch(() => ({}));
  console.log(`[tokenManager] Step 2 response ${step2Res.status}:`, JSON.stringify(step2Data).slice(0, 200));

  if (!step2Res.ok) {
    throw new Error(`Step 2 failed ${step2Res.status}: ${JSON.stringify(step2Data)}`);
  }

  const token = step2Data?.token;
  if (token && typeof token === 'string' && token.startsWith('eyJ')) {
    console.log('[tokenManager] Token obtained successfully');
    return token;
  }

  console.error('[tokenManager] No token in step 2 response:', JSON.stringify(step2Data));
  throw new Error('Step 2 returned no token — check Railway logs');
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
  }, 10 * 60 * 1000);
}

module.exports = { getToken, scheduleAutoRefresh };

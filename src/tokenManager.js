const fetch = require('node-fetch');

const TOKEN_TTL_MS = 50 * 60 * 1000;
const REFRESH_THRESHOLD_MS = 10 * 60 * 1000;

let cachedToken = null;
let tokenFetchedAt = null;

function isTokenFresh() {
  if (!cachedToken || !tokenFetchedAt) return false;
  return (Date.now() - tokenFetchedAt) < TOKEN_TTL_MS;
}

function needsRefresh() {
  if (!cachedToken || !tokenFetchedAt) return false;
  return (Date.now() - tokenFetchedAt) > (TOKEN_TTL_MS - REFRESH_THRESHOLD_MS);
}

function buildHeaders(domain, extra = {}) {
  return {
    'accept': 'application/json, text/plain, */*',
    'content-type': 'application/json',
    'app-name': 'spm-ts',
    'channel': 'APP',
    'source': 'WEB_USER',
    'token-id': '',
    'version': '2021-07-28',
    'origin': `https://${domain}`,
    'referer': `https://${domain}/`,
    'route-name': 'login',
    'route-path': `https://${domain}/`,
    'route-pattern': `https://${domain}/`,
    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    ...extra,
  };
}

async function doStep1(email, password, domain, subdomain, companyId, deviceId) {
  const deviceName = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

  console.log('[tokenManager] Step 1: email/password login...');
  const res = await fetch('https://backend.leadconnectorhq.com/oauth/2/login/email', {
    method: 'POST',
    headers: buildHeaders(domain),
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

  const data = await res.json().catch(() => ({}));
  console.log(`[tokenManager] Step 1 response ${res.status}:`, JSON.stringify(data).slice(0, 300));

  // Capture cookies
  const setCookie = res.headers.raw()['set-cookie'] || [];
  const cookies = setCookie.map(c => c.split(';')[0]).join('; ');

  if (!res.ok) throw new Error(`Step 1 failed ${res.status}: ${JSON.stringify(data)}`);

  return { data, cookies, headers: Object.fromEntries(res.headers.entries()) };
}

async function doStep2(step1Result, email, companyId, deviceId, domain, locationIds) {
  const { cookies } = step1Result;

  console.log('[tokenManager] Step 2: signin/refresh...');
  const res = await fetch(
    `https://backend.leadconnectorhq.com/oauth/2/login/signin/refresh?version=2&location_id=${locationIds}`,
    {
      method: 'POST',
      headers: buildHeaders(domain, {
        ...(cookies ? { cookie: cookies } : {}),
      }),
      body: JSON.stringify({
        email,
        companyId,
        deviceId,
        deviceType: 'web',
      }),
    }
  );

  const data = await res.json().catch(() => ({}));
  console.log(`[tokenManager] Step 2 response ${res.status}:`, JSON.stringify(data).slice(0, 300));

  if (!res.ok) throw new Error(`Step 2 failed ${res.status}: ${JSON.stringify(data)}`);

  const token = data?.token;
  if (token && token.startsWith('eyJ')) return token;

  throw new Error('Step 2 returned no token: ' + JSON.stringify(data));
}

async function doSigninRefresh(currentToken, email, companyId, deviceId, domain, locationIds) {
  console.log('[tokenManager] Refreshing existing token via signin/refresh...');
  const res = await fetch(
    `https://backend.leadconnectorhq.com/oauth/2/login/signin/refresh?version=2&location_id=${locationIds}`,
    {
      method: 'POST',
      headers: buildHeaders(domain, {
        'Authorization': `Bearer ${currentToken}`,
      }),
      body: JSON.stringify({
        email,
        companyId,
        deviceId,
        deviceType: 'web',
      }),
    }
  );

  const data = await res.json().catch(() => ({}));
  console.log(`[tokenManager] Refresh response ${res.status}:`, JSON.stringify(data).slice(0, 200));

  if (!res.ok) throw new Error(`Refresh failed ${res.status}: ${JSON.stringify(data)}`);

  const token = data?.token;
  if (token && token.startsWith('eyJ')) return token;

  throw new Error('Refresh returned no token: ' + JSON.stringify(data));
}

async function loginAndGetToken() {
  const email = process.env.GHL_EMAIL;
  const password = process.env.GHL_PASSWORD;
  const domain = process.env.GHL_DOMAIN || 'app.smartfollowups.com';
  const subdomain = process.env.GHL_SUBDOMAIN || 'app';
  const companyId = process.env.GHL_COMPANY_ID;
  const deviceId = process.env.GHL_DEVICE_ID || 'c1108bc1-400c-49a0-9478-13d8c2314a3a';
  const locationIds = process.env.GHL_LOCATION_IDS || 'FLZRGfeCUdQxcRE17Wl3,xI7jo1cy8HaLsOy7ML5I,fBmHS43QUr0H51dHbiqr';

  if (!email || !password) throw new Error('GHL_EMAIL or GHL_PASSWORD not set');

  const step1Result = await doStep1(email, password, domain, subdomain, companyId, deviceId);
  const token = await doStep2(step1Result, email, companyId, deviceId, domain, locationIds);
  return token;
}

async function getToken() {
  // If we have a fresh token and it doesn't need refresh yet, return it
  if (isTokenFresh() && !needsRefresh()) return cachedToken;

  // If token exists and just needs a refresh, try signin/refresh first
  if (cachedToken && needsRefresh()) {
    const email = process.env.GHL_EMAIL;
    const companyId = process.env.GHL_COMPANY_ID;
    const deviceId = process.env.GHL_DEVICE_ID || 'c1108bc1-400c-49a0-9478-13d8c2314a3a';
    const domain = process.env.GHL_DOMAIN || 'app.smartfollowups.com';
    const locationIds = process.env.GHL_LOCATION_IDS || 'FLZRGfeCUdQxcRE17Wl3,xI7jo1cy8HaLsOy7ML5I,fBmHS43QUr0H51dHbiqr';
    try {
      const newToken = await doSigninRefresh(cachedToken, email, companyId, deviceId, domain, locationIds);
      cachedToken = newToken;
      tokenFetchedAt = Date.now();
      return cachedToken;
    } catch (e) {
      console.warn('[tokenManager] Silent refresh failed, re-logging in:', e.message);
    }
  }

  // No token — do full login
  const token = await loginAndGetToken();
  cachedToken = token;
  tokenFetchedAt = Date.now();
  return cachedToken;
}

async function initialize() {
  try {
    await getToken();
    console.log('[tokenManager] Initialized successfully');
  } catch (e) {
    console.error('[tokenManager] Init failed:', e.message);
  }
}

function scheduleAutoRefresh() {
  setInterval(async () => {
    try {
      if (needsRefresh()) {
        console.log('[tokenManager] Scheduled refresh...');
        await getToken();
      }
    } catch (e) {
      console.error('[tokenManager] Scheduled refresh failed:', e.message);
    }
  }, 5 * 60 * 1000);
}

module.exports = { getToken, initialize, scheduleAutoRefresh };

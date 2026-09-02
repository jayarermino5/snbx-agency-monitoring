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

function buildBaseHeaders(domain) {
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
    'x-translations-lang': 'en-US',
  };
}

async function doStep1(email, password, domain, subdomain, companyId, deviceId) {
  const deviceName = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
  console.log('[tokenManager] Step 1: email/password login...');

  const res = await fetch('https://backend.leadconnectorhq.com/oauth/2/login/email', {
    method: 'POST',
    headers: buildBaseHeaders(domain),
    body: JSON.stringify({ email, password, domain, subdomain, companyId, deviceId, deviceName, deviceType: 'web' }),
  });

  const data = await res.json().catch(() => ({}));
  console.log(`[tokenManager] Step 1 ${res.status}:`, JSON.stringify(data).slice(0, 300));

  // Log ALL response headers — tokens may be here
  const respHeaders = Object.fromEntries(res.headers.entries());
  console.log('[tokenManager] Step 1 response headers:', JSON.stringify(respHeaders));

  // Grab cookies
  const setCookie = res.headers.raw()['set-cookie'] || [];
  const cookies = setCookie.map(c => c.split(';')[0]).join('; ');

  // Extract bearer token from response headers if present
  const authHeader = res.headers.get('authorization') || res.headers.get('x-auth-token') || '';
  const tokenIdHeader = res.headers.get('token-id') || '';

  console.log('[tokenManager] Step 1 auth header:', authHeader.slice(0, 50));
  console.log('[tokenManager] Step 1 token-id header:', tokenIdHeader.slice(0, 50));
  console.log('[tokenManager] Step 1 cookies:', cookies.slice(0, 100));

  if (!res.ok) throw new Error(`Step 1 failed ${res.status}: ${JSON.stringify(data)}`);

  return {
    data,
    cookies,
    bearerToken: authHeader.replace('Bearer ', '').trim(),
    tokenId: tokenIdHeader.trim(),
    respHeaders,
  };
}

async function doStep2(step1, email, companyId, deviceId, domain, locationIds) {
  const { cookies, bearerToken, tokenId, data: step1Data } = step1;
  console.log('[tokenManager] Step 2: signin/refresh...');
  console.log('[tokenManager] Using bearerToken:', !!bearerToken);
  console.log('[tokenManager] Using tokenId:', !!tokenId);
  console.log('[tokenManager] Using cookies:', !!cookies);

  const res = await fetch(
    `https://backend.leadconnectorhq.com/oauth/2/login/signin/refresh?version=2&location_id=${locationIds}`,
    {
      method: 'POST',
      headers: {
        ...buildBaseHeaders(domain),
        'route-name': 'agency-dashboard-main',
        'route-path': `https://${domain}/agency_dashboard`,
        'route-pattern': `https://${domain}/agency_dashboard`,
        ...(bearerToken ? { 'authorization': `Bearer ${bearerToken}` } : {}),
        ...(tokenId ? { 'token-id': tokenId } : {}),
        ...(cookies ? { 'cookie': cookies } : {}),
      },
      body: JSON.stringify({}),
    }
  );

  const data = await res.json().catch(() => ({}));
  console.log(`[tokenManager] Step 2 ${res.status}:`, JSON.stringify(data).slice(0, 300));

  if (!res.ok) {
    console.error('[tokenManager] Step 1 full data was:', JSON.stringify(step1Data));
    console.error('[tokenManager] Step 1 headers were:', JSON.stringify(step1.respHeaders));
    throw new Error(`Step 2 failed ${res.status}: ${JSON.stringify(data)}`);
  }

  const token = data?.token;
  if (token && token.startsWith('eyJ')) return token;
  throw new Error('Step 2 no token: ' + JSON.stringify(data));
}

async function doSigninRefresh(currentToken, firebaseToken, email, companyId, deviceId, domain, locationIds) {
  console.log('[tokenManager] Refreshing via signin/refresh...');
  const res = await fetch(
    `https://backend.leadconnectorhq.com/oauth/2/login/signin/refresh?version=2&location_id=${locationIds}`,
    {
      method: 'POST',
      headers: {
        ...buildBaseHeaders(domain),
        'route-name': 'agency-dashboard-main',
        'route-path': `https://${domain}/agency_dashboard`,
        'route-pattern': `https://${domain}/agency_dashboard`,
        'authorization': `Bearer ${currentToken}`,
        ...(firebaseToken ? { 'token-id': firebaseToken } : {}),
      },
      body: JSON.stringify({}),
    }
  );

  const data = await res.json().catch(() => ({}));
  console.log(`[tokenManager] Refresh ${res.status}:`, JSON.stringify(data).slice(0, 200));
  if (!res.ok) throw new Error(`Refresh failed ${res.status}: ${JSON.stringify(data)}`);

  const token = data?.token;
  if (token && token.startsWith('eyJ')) return token;
  throw new Error('Refresh no token: ' + JSON.stringify(data));
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

  const step1 = await doStep1(email, password, domain, subdomain, companyId, deviceId);
  return await doStep2(step1, email, companyId, deviceId, domain, locationIds);
}

async function getToken() {
  if (isTokenFresh() && !needsRefresh()) return cachedToken;

  if (cachedToken && needsRefresh()) {
    const domain = process.env.GHL_DOMAIN || 'app.smartfollowups.com';
    const email = process.env.GHL_EMAIL;
    const companyId = process.env.GHL_COMPANY_ID;
    const deviceId = process.env.GHL_DEVICE_ID || 'c1108bc1-400c-49a0-9478-13d8c2314a3a';
    const locationIds = process.env.GHL_LOCATION_IDS || 'FLZRGfeCUdQxcRE17Wl3,xI7jo1cy8HaLsOy7ML5I,fBmHS43QUr0H51dHbiqr';
    try {
      const newToken = await doSigninRefresh(cachedToken, null, email, companyId, deviceId, domain, locationIds);
      cachedToken = newToken;
      tokenFetchedAt = Date.now();
      return cachedToken;
    } catch (e) {
      console.warn('[tokenManager] Silent refresh failed, re-logging in:', e.message);
    }
  }

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
      if (needsRefresh()) await getToken();
    } catch (e) {
      console.error('[tokenManager] Scheduled refresh failed:', e.message);
    }
  }, 5 * 60 * 1000);
}

module.exports = { getToken, initialize, scheduleAutoRefresh };

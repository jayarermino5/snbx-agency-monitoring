const fetch = require('node-fetch');

// Tokens last ~1 hour, we refresh at 50 min
const TOKEN_TTL_MS = 50 * 60 * 1000;

let cachedToken = null;       // the final agency JWT
let bearerToken = null;       // short-lived session token (from env seed)
let firebaseToken = null;     // firebase token-id (from env seed)
let tokenFetchedAt = null;

function isTokenFresh() {
  return cachedToken && tokenFetchedAt && (Date.now() - tokenFetchedAt) < TOKEN_TTL_MS;
}

function buildHeaders(domain, extra = {}) {
  return {
    'accept': 'application/json, text/plain, */*',
    'content-type': 'application/json',
    'app-name': 'spm-ts',
    'channel': 'APP',
    'source': 'WEB_USER',
    'version': '2021-07-28',
    'origin': `https://${domain}`,
    'referer': `https://${domain}/`,
    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    'x-translations-lang': 'en-US',
    ...extra,
  };
}

async function doSigninRefresh(domain, locationIds) {
  console.log('[tokenManager] Calling signin/refresh...');
  const companyId = process.env.GHL_COMPANY_ID;
  const deviceId = process.env.GHL_DEVICE_ID || 'c1108bc1-400c-49a0-9478-13d8c2314a3a';

  const res = await fetch(
    `https://backend.leadconnectorhq.com/oauth/2/login/signin/refresh?version=2&location_id=${locationIds}`,
    {
      method: 'POST',
      headers: buildHeaders(domain, {
        'route-name': 'agency-dashboard-main',
        'route-path': `https://${domain}/agency_dashboard`,
        'route-pattern': `https://${domain}/agency_dashboard`,
        'authorization': `Bearer ${bearerToken}`,
        'token-id': firebaseToken || '',
      }),
      body: JSON.stringify({}),
    }
  );

  const data = await res.json().catch(() => ({}));
  console.log(`[tokenManager] signin/refresh ${res.status}:`, JSON.stringify(data).slice(0, 200));

  if (!res.ok) throw new Error(`signin/refresh failed ${res.status}: ${JSON.stringify(data)}`);

  const token = data?.token;
  if (token && token.startsWith('eyJ')) return token;
  throw new Error('signin/refresh returned no token: ' + JSON.stringify(data));
}

async function getToken() {
  if (isTokenFresh()) return cachedToken;

  const domain = process.env.GHL_DOMAIN || 'app.smartfollowups.com';
  const locationIds = process.env.GHL_LOCATION_IDS || 'FLZRGfeCUdQxcRE17Wl3,xI7jo1cy8HaLsOy7ML5I,fBmHS43QUr0H51dHbiqr';

  // Load seed tokens from env if not yet loaded
  if (!bearerToken) {
    bearerToken = (process.env.GHL_BEARER_TOKEN || '').trim();
    if (!bearerToken) throw new Error(
      'GHL_BEARER_TOKEN not set. Grab it from DevTools → signin/refresh request → Authorization header (without "Bearer ").'
    );
  }
  if (!firebaseToken) {
    firebaseToken = (process.env.GHL_TOKEN_ID || '').trim();
    if (!firebaseToken) throw new Error(
      'GHL_TOKEN_ID not set. Grab it from DevTools → signin/refresh request → token-id header.'
    );
  }

  const token = await doSigninRefresh(domain, locationIds);
  cachedToken = token;
  // Also update bearerToken with the refreshed one for next cycle
  bearerToken = token;
  tokenFetchedAt = Date.now();
  console.log('[tokenManager] Token refreshed successfully');
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
    if (!isTokenFresh()) {
      try {
        console.log('[tokenManager] Scheduled refresh...');
        await getToken();
      } catch (e) {
        console.error('[tokenManager] Scheduled refresh failed:', e.message);
      }
    }
  }, 5 * 60 * 1000);
}

module.exports = { getToken, initialize, scheduleAutoRefresh };

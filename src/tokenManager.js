const fetch = require('node-fetch');

const TOKEN_TTL_MS = 50 * 60 * 1000;  // refresh every 50 min
const REFRESH_THRESHOLD_MS = 10 * 60 * 1000; // refresh when <10 min left

let cachedToken = null;
let tokenFetchedAt = null;
let refreshing = false;
let refreshQueue = [];

function isTokenFresh() {
  if (!cachedToken || !tokenFetchedAt) return false;
  return (Date.now() - tokenFetchedAt) < TOKEN_TTL_MS;
}

function needsRefresh() {
  if (!cachedToken || !tokenFetchedAt) return false;
  const age = Date.now() - tokenFetchedAt;
  return age > (TOKEN_TTL_MS - REFRESH_THRESHOLD_MS);
}

async function refreshToken(currentToken) {
  const domain = process.env.GHL_DOMAIN || 'app.gohighlevel.com';
  const companyId = process.env.GHL_COMPANY_ID;
  const deviceId = process.env.GHL_DEVICE_ID || 'c1108bc1-400c-49a0-9478-13d8c2314a3a';
  const locationIds = process.env.GHL_LOCATION_IDS || 'FLZRGfeCUdQxcRE17Wl3,xI7jo1cy8HaLsOy7ML5I,fBmHS43QUr0H51dHbiqr';
  const email = process.env.GHL_EMAIL;
  const deviceName = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

  console.log('[tokenManager] Refreshing via signin/refresh...');

  const res = await fetch(
    `https://backend.leadconnectorhq.com/oauth/2/login/signin/refresh?version=2&location_id=${locationIds}`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'version': '2021-07-28',
        'Authorization': `Bearer ${currentToken}`,
        'origin': `https://${domain}`,
        'referer': `https://${domain}/`,
        'user-agent': deviceName,
      },
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

  if (!res.ok) {
    throw new Error(`Token refresh failed ${res.status}: ${JSON.stringify(data)}`);
  }

  const newToken = data?.token;
  if (newToken && typeof newToken === 'string' && newToken.startsWith('eyJ')) {
    return newToken;
  }

  throw new Error('Refresh response contained no token: ' + JSON.stringify(data));
}

async function getToken() {
  // Use cached token if still fresh
  if (isTokenFresh() && !needsRefresh()) return cachedToken;

  // If token exists but needs refresh, try to refresh it
  if (cachedToken && needsRefresh()) {
    try {
      const newToken = await refreshToken(cachedToken);
      cachedToken = newToken;
      tokenFetchedAt = Date.now();
      console.log('[tokenManager] Token silently refreshed');
      return cachedToken;
    } catch (e) {
      console.warn('[tokenManager] Silent refresh failed, using existing token:', e.message);
      if (isTokenFresh()) return cachedToken; // still usable
    }
  }

  // No token at all — check env for seed token
  if (!cachedToken) {
    const seedToken = process.env.GHL_BEARER_TOKEN;
    if (seedToken && seedToken.trim().startsWith('eyJ')) {
      console.log('[tokenManager] Using seed token from GHL_BEARER_TOKEN env var');
      cachedToken = seedToken.trim();
      tokenFetchedAt = Date.now();

      // Immediately refresh it to get a fresh one
      try {
        const newToken = await refreshToken(cachedToken);
        cachedToken = newToken;
        tokenFetchedAt = Date.now();
        console.log('[tokenManager] Seed token refreshed successfully');
      } catch (e) {
        console.warn('[tokenManager] Could not refresh seed token, using as-is:', e.message);
      }

      return cachedToken;
    }

    throw new Error(
      'No token available. Set GHL_BEARER_TOKEN in Railway Variables with a fresh token from DevTools. ' +
      'The server will then keep it alive automatically via signin/refresh.'
    );
  }

  return cachedToken;
}

// Called on startup — pre-warm the token
async function initialize() {
  try {
    await getToken();
    console.log('[tokenManager] Initialized successfully');
  } catch (e) {
    console.error('[tokenManager] Initialization failed:', e.message);
    console.error('[tokenManager] ACTION REQUIRED: Set GHL_BEARER_TOKEN in Railway Variables');
  }
}

function scheduleAutoRefresh() {
  // Check every 5 minutes, refresh if needed
  setInterval(async () => {
    try {
      if (cachedToken && needsRefresh()) {
        console.log('[tokenManager] Scheduled refresh triggered');
        const newToken = await refreshToken(cachedToken);
        cachedToken = newToken;
        tokenFetchedAt = Date.now();
        console.log('[tokenManager] Scheduled refresh complete');
      }
    } catch (e) {
      console.error('[tokenManager] Scheduled refresh failed:', e.message);
    }
  }, 5 * 60 * 1000);
}

module.exports = { getToken, initialize, scheduleAutoRefresh };

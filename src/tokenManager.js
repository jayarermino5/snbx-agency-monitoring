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

  if (!email || !password) {
    throw new Error('GHL_EMAIL or GHL_PASSWORD not set in environment');
  }

  console.log('[tokenManager] Attempting API login...');

  // Step 1: try the direct GHL auth API
  const endpoints = [
    {
      url: 'https://services.leadconnectorhq.com/oauth/token',
      body: { grant_type: 'password', email, password, client_id: 'app' },
      tokenPath: 'access_token',
    },
    {
      url: 'https://backend.leadconnectorhq.com/auth/login',
      body: { email, password },
      tokenPath: 'token',
    },
    {
      url: `https://services.leadconnectorhq.com/oauth/user/login`,
      body: { email, password },
      tokenPath: 'access_token',
    },
  ];

  for (const ep of endpoints) {
    try {
      console.log(`[tokenManager] Trying endpoint: ${ep.url}`);
      const res = await fetch(ep.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          version: '2021-07-28',
          origin: `https://${domain}`,
          referer: `https://${domain}/`,
        },
        body: JSON.stringify(ep.body),
      });

      const data = await res.json();
      console.log(`[tokenManager] Response status: ${res.status}`);

      // Walk the token path
      const keys = ep.tokenPath.split('.');
      let token = data;
      for (const k of keys) token = token?.[k];

      if (token && typeof token === 'string' && token.startsWith('eyJ')) {
        console.log('[tokenManager] Token obtained via API login');
        return token;
      }

      console.log(`[tokenManager] No token in response:`, JSON.stringify(data).slice(0, 200));
    } catch (e) {
      console.log(`[tokenManager] Endpoint failed: ${e.message}`);
    }
  }

  throw new Error('All login endpoints failed — check GHL_EMAIL, GHL_PASSWORD, and GHL_DOMAIN');
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

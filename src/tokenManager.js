const fetch = require('node-fetch');

const TOKEN_TTL_MS = 45 * 60 * 1000; // 45 minutes

let cachedToken = null;
let tokenFetchedAt = null;
let refreshing = false;
let refreshQueue = [];

function isTokenFresh() {
  return cachedToken && tokenFetchedAt && (Date.now() - tokenFetchedAt < TOKEN_TTL_MS);
}

function extractToken(data) {
  const candidates = [
    data?.access_token,
    data?.token,
    data?.authToken,
    data?.idToken,
    data?.id_token,
    data?.jwt,
    data?.data?.access_token,
    data?.data?.token,
    data?.data?.authToken,
    data?.user?.token,
    data?.user?.access_token,
    data?.tokenData?.access_token,
    data?.tokenData?.token,
  ];
  return candidates.find(t => t && typeof t === 'string' && t.startsWith('eyJ')) || null;
}

async function loginAndGetToken() {
  const email = process.env.GHL_EMAIL;
  const password = process.env.GHL_PASSWORD;
  const domain = process.env.GHL_DOMAIN || 'app.gohighlevel.com';

  if (!email || !password) {
    throw new Error('GHL_EMAIL or GHL_PASSWORD not set in environment');
  }

  console.log('[tokenManager] Attempting login via backend.leadconnectorhq.com/oauth/2/login/email...');

  const r = await fetch('https://backend.leadconnectorhq.com/oauth/2/login/email', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      origin: `https://${domain}`,
      referer: `https://${domain}/`,
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    },
    body: JSON.stringify({ email, password }),
  });

  const data = await r.json().catch(() => ({}));
  console.log(`[tokenManager] Login response ${r.status}:`, JSON.stringify(data).slice(0, 300));

  if (!r.ok) {
    throw new Error(`Login failed ${r.status}: ${JSON.stringify(data)}`);
  }

  const token = extractToken(data);
  if (token) {
    console.log('[tokenManager] Token extracted successfully');
    return token;
  }

  // Log full response so we can see exact structure
  console.error('[tokenManager] Token not found in response. Full response:', JSON.stringify(data));
  throw new Error('Login succeeded but no token found in response — check Railway logs for response structure');
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

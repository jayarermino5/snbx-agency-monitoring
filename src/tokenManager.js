const fetch = require('node-fetch');
const FormData = require('form-data');

const TOKEN_TTL_MS = 45 * 60 * 1000; // 45 minutes

let cachedToken = null;
let tokenFetchedAt = null;
let refreshing = false;
let refreshQueue = [];

function isTokenFresh() {
  return cachedToken && tokenFetchedAt && (Date.now() - tokenFetchedAt < TOKEN_TTL_MS);
}

function extractToken(data) {
  // Walk common token field names recursively (1 level deep)
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

  const commonHeaders = {
    origin: `https://${domain}`,
    referer: `https://${domain}/`,
    version: '2021-07-28',
  };

  const attempts = [];

  // Attempt 1: smartfollowups multipart/form-data
  try {
    const form = new FormData();
    form.append('email', email);
    form.append('password', password);
    const r = await fetch(`https://${domain}/api/v1/auth/login`, {
      method: 'POST',
      headers: { ...form.getHeaders(), ...commonHeaders },
      body: form,
    });
    const data = await r.json().catch(() => ({}));
    console.log(`[tokenManager] smartfollowups-multipart: ${r.status}`, JSON.stringify(data).slice(0, 200));
    const token = extractToken(data);
    if (token) return token;
    attempts.push({ name: 'smartfollowups-multipart', status: r.status, data });
  } catch (e) {
    console.log('[tokenManager] smartfollowups-multipart failed:', e.message);
  }

  // Attempt 2: GHL identity service
  try {
    const r = await fetch('https://services.leadconnectorhq.com/oauth/user/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...commonHeaders },
      body: JSON.stringify({ email, password, grant_type: 'password' }),
    });
    const data = await r.json().catch(() => ({}));
    console.log(`[tokenManager] user-token: ${r.status}`, JSON.stringify(data).slice(0, 200));
    const token = extractToken(data);
    if (token) return token;
    attempts.push({ name: 'user-token', status: r.status, data });
  } catch (e) {
    console.log('[tokenManager] user-token failed:', e.message);
  }

  // Attempt 3: identity.gohighlevel.com
  try {
    const r = await fetch('https://identity.gohighlevel.com/api/v1/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...commonHeaders },
      body: JSON.stringify({ email, password }),
    });
    const data = await r.json().catch(() => ({}));
    console.log(`[tokenManager] identity-login: ${r.status}`, JSON.stringify(data).slice(0, 200));
    const token = extractToken(data);
    if (token) return token;
    attempts.push({ name: 'identity-login', status: r.status, data });
  } catch (e) {
    console.log('[tokenManager] identity-login failed:', e.message);
  }

  // Attempt 4: backend.leadconnectorhq.com with JSON
  try {
    const r = await fetch('https://backend.leadconnectorhq.com/user/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...commonHeaders },
      body: JSON.stringify({ email, password }),
    });
    const data = await r.json().catch(() => ({}));
    console.log(`[tokenManager] backend-user-login: ${r.status}`, JSON.stringify(data).slice(0, 200));
    const token = extractToken(data);
    if (token) return token;
    attempts.push({ name: 'backend-user-login', status: r.status, data });
  } catch (e) {
    console.log('[tokenManager] backend-user-login failed:', e.message);
  }

  console.error('[tokenManager] All attempts failed:', JSON.stringify(attempts));
  throw new Error('All login endpoints failed — check Railway logs for details');
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

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
    data?.token,
    data?.access_token,
    data?.authToken,
    data?.idToken,
    data?.id_token,
    data?.data?.token,
    data?.data?.access_token,
    data?.user?.token,
  ];
  return candidates.find(t => t && typeof t === 'string' && t.startsWith('eyJ')) || null;
}

async function loginAndGetToken() {
  const email = process.env.GHL_EMAIL;
  const password = process.env.GHL_PASSWORD;
  const domain = process.env.GHL_DOMAIN || 'app.gohighlevel.com';
  const subdomain = process.env.GHL_SUBDOMAIN || 'app';
  const companyId = process.env.GHL_COMPANY_ID;
  const deviceId = process.env.GHL_DEVICE_ID || 'c1108bc1-400c-49a0-9478-13d8c2314a3a';
  const locationIds = process.env.GHL_LOCATION_IDS || 'FLZRGfeCUdQxcRE17Wl3,xI7jo1cy8HaLsOy7ML5I,fBmHS43QUr0H51dHbiqr';
  const deviceName = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

  if (!email || !password) throw new Error('GHL_EMAIL or GHL_PASSWORD not set');

  const baseHeaders = {
    'Content-Type': 'application/json',
    'version': '2021-07-28',
    'origin': `https://${domain}`,
    'referer': `https://${domain}/`,
    'user-agent': deviceName,
  };

  // Step 1: email/password → returns a temporary session token
  console.log('[tokenManager] Step 1: email login...');
  const step1Res = await fetch('https://backend.leadconnectorhq.com/oauth/2/login/email', {
    method: 'POST',
    headers: baseHeaders,
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
  console.log(`[tokenManager] Step 1 response ${step1Res.status}:`, JSON.stringify(step1Data).slice(0, 300));

  if (!step1Res.ok) {
    throw new Error(`Step 1 failed ${step1Res.status}: ${JSON.stringify(step1Data)}`);
  }

  // Extract session token from step 1 — could be in response body or cookies
  const step1Token = extractToken(step1Data);
  const setCookie = step1Res.headers.raw()['set-cookie'] || [];
  const cookieHeader = setCookie.map(c => c.split(';')[0]).join('; ');

  console.log('[tokenManager] Step 1 token found:', !!step1Token);
  console.log('[tokenManager] Step 1 cookies:', cookieHeader.slice(0, 100));

  // If step 1 already returned a full agency token, use it directly
  if (step1Token) {
    console.log('[tokenManager] Using step 1 token directly');
    return step1Token;
  }

  // Step 2: signin/refresh — pass step 1 token as Authorization
  console.log('[tokenManager] Step 2: signin refresh...');

  // Build step 2 headers — include Authorization if we got a token
  const step2Headers = {
    ...baseHeaders,
    ...(cookieHeader ? { cookie: cookieHeader } : {}),
  };

  // Try with traceId from step 1 as the auth mechanism
  const traceId = step1Data?.traceId;
  if (traceId) {
    step2Headers['x-trace-id'] = traceId;
  }

  const step2Res = await fetch(
    `https://backend.leadconnectorhq.com/oauth/2/login/signin/refresh?version=2&location_id=${locationIds}`,
    {
      method: 'POST',
      headers: step2Headers,
      body: JSON.stringify({
        email,
        companyId,
        deviceId,
        deviceType: 'web',
        traceId,
      }),
    }
  );

  const step2Data = await step2Res.json().catch(() => ({}));
  console.log(`[tokenManager] Step 2 response ${step2Res.status}:`, JSON.stringify(step2Data).slice(0, 300));

  if (!step2Res.ok) {
    // Log ALL step 1 response details to find the auth mechanism
    console.error('[tokenManager] Step 1 full response:', JSON.stringify(step1Data));
    console.error('[tokenManager] Step 1 headers:', JSON.stringify(Object.fromEntries(step1Res.headers.entries())));
    throw new Error(`Step 2 failed ${step2Res.status}: ${JSON.stringify(step2Data)}`);
  }

  const finalToken = extractToken(step2Data);
  if (finalToken) {
    console.log('[tokenManager] Token obtained successfully');
    return finalToken;
  }

  console.error('[tokenManager] No token in step 2:', JSON.stringify(step2Data));
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

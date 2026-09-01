const express = require('express');
const fetch = require('node-fetch');

const router = express.Router();

// GET /api/debug/login
// Tests all login endpoints and returns full responses for diagnosis
router.get('/login', async (req, res) => {
  const email = process.env.GHL_EMAIL;
  const password = process.env.GHL_PASSWORD;
  const domain = process.env.GHL_DOMAIN || 'app.gohighlevel.com';

  if (!email || !password) {
    return res.status(500).json({ error: 'GHL_EMAIL or GHL_PASSWORD not set' });
  }

  const attempts = [];

  const endpoints = [
    {
      name: 'leadconnector-oauth-token',
      url: 'https://services.leadconnectorhq.com/oauth/token',
      body: { grant_type: 'password', email, password, client_id: 'app' },
    },
    {
      name: 'leadconnector-user-login',
      url: 'https://services.leadconnectorhq.com/oauth/user/login',
      body: { email, password },
    },
    {
      name: 'backend-auth-login',
      url: 'https://backend.leadconnectorhq.com/auth/login',
      body: { email, password },
    },
    {
      name: 'backend-auth-email',
      url: 'https://backend.leadconnectorhq.com/auth/email',
      body: { email, password },
    },
    {
      name: 'services-user-login',
      url: 'https://services.leadconnectorhq.com/user/login',
      body: { email, password },
    },
    {
      name: 'smartfollowups-login',
      url: `https://${domain}/api/v1/auth/login`,
      body: { email, password },
    },
  ];

  for (const ep of endpoints) {
    try {
      const r = await fetch(ep.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          version: '2021-07-28',
          origin: `https://${domain}`,
          referer: `https://${domain}/`,
        },
        body: JSON.stringify(ep.body),
      });

      const text = await r.text();
      let json = null;
      try { json = JSON.parse(text); } catch (_) {}

      attempts.push({
        name: ep.name,
        url: ep.url,
        status: r.status,
        response: json || text.slice(0, 300),
      });
    } catch (e) {
      attempts.push({
        name: ep.name,
        url: ep.url,
        status: 'FETCH_ERROR',
        response: e.message,
      });
    }
  }

  res.json({ domain, attempts });
});

module.exports = router;

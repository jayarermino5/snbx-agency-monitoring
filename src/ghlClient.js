const fetch = require('node-fetch');

const BASE = 'https://services.leadconnectorhq.com';
const COMPANY_ID = process.env.GHL_COMPANY_ID;

function getToken() {
  const token = process.env.GHL_BEARER_TOKEN;
  if (!token) throw new Error('GHL_BEARER_TOKEN is not set in environment variables');
  return token.trim();  // ← add .trim()
}

function getCompanyId() {
  if (!COMPANY_ID) throw new Error('GHL_COMPANY_ID is not set in environment variables');
  return COMPANY_ID;
}

async function ghlFetch(path) {
  const token = getToken();
  const url = `${BASE}${path}`;
  console.log(`[ghlFetch] GET ${url}`);

  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      version: '2021-07-28',
    },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GHL API error ${res.status}: ${text}`);
  }

  return res.json();
}

module.exports = { ghlFetch, getCompanyId };

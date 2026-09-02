const fetch = require('node-fetch');

const BASE = 'https://services.leadconnectorhq.com';

function getCompanyId() {
  const id = process.env.GHL_COMPANY_ID;
  if (!id) throw new Error('GHL_COMPANY_ID is not set');
  return id;
}

function getTokenId() {
  const token = process.env.GHL_TOKEN_ID;
  if (!token) throw new Error('GHL_TOKEN_ID is not set');
  return token.trim();
}

async function ghlFetch(path) {
  const tokenId = getTokenId();
  const url = `${BASE}${path}`;
  console.log(`[ghlFetch] GET ${url}`);

  const res = await fetch(url, {
    headers: {
      'token-id': tokenId,
      'Content-Type': 'application/json',
      'version': '2021-07-28',
    },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GHL API error ${res.status}: ${text}`);
  }

  return res.json();
}

module.exports = { ghlFetch, getCompanyId };

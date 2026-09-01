# SNBX Billing API

Railway-hosted proxy backend for the SNBX Pro GHL billing monitoring dashboard.

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Health check |
| GET | `/api/wallet` | All sub-accounts wallet usage (all months) |
| GET | `/api/wallet?sortBy=2026-09&sortOrder=desc` | Sorted by specific month |
| GET | `/api/ai` | AI Suite usage, current month |
| GET | `/api/ai?startDate=2026-08-01&endDate=2026-09-01` | AI Suite for custom date range |

## Deploy to Railway

1. Push this repo to GitHub
2. Go to [railway.app](https://railway.app) → New Project → Deploy from GitHub repo
3. Select this repo
4. Go to your service → **Variables** tab → add:

| Variable | Value |
|----------|-------|
| `GHL_BEARER_TOKEN` | Your full Bearer token from DevTools |
| `GHL_COMPANY_ID` | `oQSMP3c4iGGr95ucEyAM` |

5. Railway auto-detects Node.js and sets `PORT` — do not override it
6. Your API will be live at `https://your-service.up.railway.app`

## Local development

```bash
cp .env.example .env
# fill in your token and company ID in .env
npm install
npm run dev
```

## Token expiry

GHL Bearer tokens expire. When the dashboard stops loading:
1. Open DevTools on app.smartfollowups.com → Network tab
2. Find any request → copy the Authorization header value
3. Update `GHL_BEARER_TOKEN` in Railway Variables
4. Railway will redeploy automatically

## Frontend

The GHL AI Studio custom page prompt is in `frontend-prompt.md`.

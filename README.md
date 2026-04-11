# Moscow Weather Telegram Bot

Telegram bot for Moscow weather and clothing recommendation.

This repository now supports two modes:

- Cloudflare Workers (recommended for your hosting case)
- Python long polling (local or VPS)

## Features

- `/weather` for current Moscow weather
- `/today` for an hour-by-hour summary of today
- `/week` for a 7-day forecast
- Telegram slash command suggestions via `setMyCommands`
- clothing recommendation by temperature, feels-like, wind, and precipitation
- admin panel with user count and broadcast mode
- free Open-Meteo API (no weather API key)

## Cloudflare Workers (recommended)

### 1) Prerequisites

- Telegram bot token from BotFather
- Cloudflare account
- Node.js 18+

### 2) Install and login

```bash
npm install
npx wrangler login
```

### 3) Set secrets in Cloudflare

```bash
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put TELEGRAM_SECRET_TOKEN
```

`TELEGRAM_SECRET_TOKEN` is any long random string you choose.

Add your Telegram user ID to `ADMIN_TELEGRAM_USER_IDS` in `.dev.vars` for local testing, or use the same variable in Cloudflare secrets if you prefer. Separate multiple admin IDs with commas.

For a Cloudflare deploy, set `ADMIN_TELEGRAM_USER_IDS` in the dashboard or with `wrangler secret put ADMIN_TELEGRAM_USER_IDS`.

The worker uses a Durable Object named `BOT_STATE` for persistent users and admin state, so no extra KV setup is required.

### 4) Deploy worker

```bash
npx wrangler deploy
```

After deploy, Wrangler prints your worker URL, for example:

`https://moscow-weather-bot.<subdomain>.workers.dev`

### 5) Set Telegram webhook

Replace placeholders and run:

```bash
curl -X POST "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/setWebhook" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://moscow-weather-bot.<subdomain>.workers.dev","secret_token":"<TELEGRAM_SECRET_TOKEN>"}'
```

### 6) Check webhook status

```bash
curl "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/getWebhookInfo"
```

If `last_error_message` is empty and URL is correct, bot is ready.

## Local Worker development

1. Copy `.dev.vars.example` to `.dev.vars`
2. Put real values for `TELEGRAM_BOT_TOKEN` and `TELEGRAM_SECRET_TOKEN`
3. Run:

```bash
npx wrangler dev
```

## Python mode (fallback)

Python implementation is still available in `bot.py`.

It uses a local SQLite file named `bot_data.sqlite3` to store users and admin broadcast state.

### Windows PowerShell

```powershell
py -3 -m venv .venv
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
$env:TELEGRAM_BOT_TOKEN="YOUR_TOKEN"
$env:ADMIN_TELEGRAM_USER_IDS="123456789"
python bot.py
```

## Project files for Workers

- `src/worker.js` - Telegram webhook handler and weather logic
- `wrangler.toml` - Cloudflare Worker config
- `package.json` - Wrangler scripts and dependencies
- `.dev.vars.example` - local env template

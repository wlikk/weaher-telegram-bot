# Moscow Weather Telegram Bot

Telegram bot for Moscow weather and clothing recommendation.

This repository now supports two modes:

- Cloudflare Workers (recommended for your hosting case)
- Python long polling (local or VPS)

## Features

- `/weather` for current Moscow weather
- clothing recommendation by temperature, feels-like, wind, and precipitation
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

### Windows PowerShell

```powershell
py -3 -m venv .venv
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
$env:TELEGRAM_BOT_TOKEN="YOUR_TOKEN"
python bot.py
```

## Project files for Workers

- `src/worker.js` - Telegram webhook handler and weather logic
- `wrangler.toml` - Cloudflare Worker config
- `package.json` - Wrangler scripts and dependencies
- `.dev.vars.example` - local env template

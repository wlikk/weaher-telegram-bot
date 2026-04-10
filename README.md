# Moscow Weather Telegram Bot

Telegram bot that returns current weather in Moscow and a clothing recommendation.

## Features

- `/weather` command for Moscow weather
- Clothing recommendation based on:
  - temperature
  - feels-like temperature
  - wind speed
  - precipitation
- Uses Open-Meteo free API (no API key required)

## Local Run

1. Create a bot with BotFather and get token.
2. Create and activate virtual environment.
3. Install dependencies.
4. Set `TELEGRAM_BOT_TOKEN` environment variable.
5. Run bot.

### Windows PowerShell

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
$env:TELEGRAM_BOT_TOKEN="YOUR_TOKEN"
python bot.py
```

## Free / Low-cost Hosting Options

### 1) Railway (trial credits)

- Easy deploy from GitHub.
- Good for quick start.
- Usually has monthly credits/trial limits.

### 2) Render (free web service may sleep)

- Simple setup.
- Free services can sleep when inactive.
- Long-polling bot may have interruptions on free tier.

### 3) Oracle Cloud Free Tier (most stable free option)

- Always Free ARM VM possible.
- Needs Linux/server basics.
- Best option if you need 24/7 bot with no sleep.

## Deploy Notes

For process-based hosting, set start command:

```bash
python bot.py
```

Required environment variable:

- `TELEGRAM_BOT_TOKEN`

## Recommended Path

If you want *really free and stable* hosting, use Oracle Cloud Free Tier VM.
If you want easiest setup, start with Railway and monitor usage limits.

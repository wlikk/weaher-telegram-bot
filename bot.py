import logging
import os
from datetime import datetime

import requests
from telegram import Update
from telegram.ext import Application, CommandHandler, ContextTypes

logging.basicConfig(
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
    level=logging.INFO,
)
logger = logging.getLogger(__name__)

MOSCOW_LAT = 55.7558
MOSCOW_LON = 37.6176


def get_moscow_weather() -> dict:
    """Fetch current weather for Moscow from Open-Meteo free API (no key required)."""
    url = "https://api.open-meteo.com/v1/forecast"
    params = {
        "latitude": MOSCOW_LAT,
        "longitude": MOSCOW_LON,
        "current": ["temperature_2m", "apparent_temperature", "relative_humidity_2m", "wind_speed_10m", "weather_code"],
        "timezone": "Europe/Moscow",
    }

    response = requests.get(url, params=params, timeout=15)
    response.raise_for_status()
    data = response.json()

    current = data.get("current", {})
    if not current:
        raise ValueError("Open-Meteo response does not contain current weather")

    return {
        "temperature": current.get("temperature_2m"),
        "feels_like": current.get("apparent_temperature"),
        "humidity": current.get("relative_humidity_2m"),
        "wind": current.get("wind_speed_10m"),
        "weather_code": current.get("weather_code"),
        "time": current.get("time"),
    }


def weather_code_to_text(code: int | None) -> str:
    mapping = {
        0: "Ясно",
        1: "Преимущественно ясно",
        2: "Переменная облачность",
        3: "Пасмурно",
        45: "Туман",
        48: "Изморозь",
        51: "Легкая морось",
        53: "Морось",
        55: "Сильная морось",
        56: "Ледяная морось",
        57: "Сильная ледяная морось",
        61: "Небольшой дождь",
        63: "Дождь",
        65: "Сильный дождь",
        66: "Ледяной дождь",
        67: "Сильный ледяной дождь",
        71: "Небольшой снег",
        73: "Снег",
        75: "Сильный снег",
        77: "Снежные зерна",
        80: "Ливень",
        81: "Ливень",
        82: "Сильный ливень",
        85: "Снегопад",
        86: "Сильный снегопад",
        95: "Гроза",
        96: "Гроза с градом",
        99: "Сильная гроза с градом",
    }
    return mapping.get(code, "Неизвестно")


def outfit_recommendation(temp: float | None, feels_like: float | None, wind: float | None, weather_code: int | None) -> str:
    if temp is None:
        return "Не могу дать рекомендацию по одежде: нет данных о температуре."

    effective_temp = feels_like if feels_like is not None else temp
    raining_or_snowing = weather_code in {51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 71, 73, 75, 77, 80, 81, 82, 85, 86}

    if effective_temp <= -15:
        recommendation = "Очень холодно: теплая зимняя куртка, шапка, шарф, перчатки, термобелье и теплые ботинки."
    elif effective_temp <= -5:
        recommendation = "Холодно: зимняя куртка, шапка и перчатки."
    elif effective_temp <= 5:
        recommendation = "Прохладно: демисезонная куртка, свитер, закрытая обувь."
    elif effective_temp <= 12:
        recommendation = "Свежо: легкая куртка/ветровка, кофта, кроссовки."
    elif effective_temp <= 20:
        recommendation = "Комфортно: худи или легкая кофта, джинсы/брюки."
    elif effective_temp <= 27:
        recommendation = "Тепло: футболка, легкие брюки или шорты."
    else:
        recommendation = "Жарко: легкая светлая одежда, головной убор и вода с собой."

    notes = []
    if wind is not None and wind >= 10:
        notes.append("На улице ветрено, лучше надеть непродуваемый верх.")
    if raining_or_snowing:
        notes.append("Есть осадки, возьми зонт и непромокаемую обувь.")

    if notes:
        recommendation += " " + " ".join(notes)

    return recommendation


async def start(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    text = (
        "Привет! Я бот погоды по Москве.\n"
        "Команды:\n"
        "/weather - текущая погода и совет по одежде\n"
        "/help - помощь"
    )
    await update.message.reply_text(text)


async def help_command(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    await update.message.reply_text("Используй /weather чтобы получить погоду в Москве и рекомендацию по одежде.")


async def weather(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    try:
        weather_data = get_moscow_weather()
    except Exception as exc:
        logger.exception("Failed to fetch weather: %s", exc)
        await update.message.reply_text("Не удалось получить погоду. Попробуй чуть позже.")
        return

    temperature = weather_data["temperature"]
    feels_like = weather_data["feels_like"]
    humidity = weather_data["humidity"]
    wind = weather_data["wind"]
    weather_code = weather_data["weather_code"]
    weather_text = weather_code_to_text(weather_code)

    recommendation = outfit_recommendation(temperature, feels_like, wind, weather_code)

    timestamp = weather_data.get("time")
    if timestamp:
        try:
            dt = datetime.fromisoformat(timestamp)
            timestamp_text = dt.strftime("%d.%m.%Y %H:%M")
        except ValueError:
            timestamp_text = timestamp
    else:
        timestamp_text = "неизвестно"

    message = (
        f"Погода в Москве на {timestamp_text}:\n"
        f"- Состояние: {weather_text}\n"
        f"- Температура: {temperature}°C\n"
        f"- Ощущается как: {feels_like}°C\n"
        f"- Влажность: {humidity}%\n"
        f"- Ветер: {wind} м/с\n\n"
        f"Рекомендация: {recommendation}"
    )

    await update.message.reply_text(message)


def main() -> None:
    token = os.getenv("TELEGRAM_BOT_TOKEN")
    if not token:
        raise RuntimeError("TELEGRAM_BOT_TOKEN is not set")

    app = Application.builder().token(token).build()
    app.add_handler(CommandHandler("start", start))
    app.add_handler(CommandHandler("help", help_command))
    app.add_handler(CommandHandler("weather", weather))

    logger.info("Bot is running with long polling")
    app.run_polling(drop_pending_updates=True)


if __name__ == "__main__":
    main()

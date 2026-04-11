import logging
import os
import sqlite3
from pathlib import Path
from datetime import datetime

import requests
from telegram import BotCommand, InlineKeyboardButton, InlineKeyboardMarkup, Update
from telegram.ext import Application, CallbackQueryHandler, CommandHandler, ContextTypes, MessageHandler, filters

logging.basicConfig(
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
    level=logging.INFO,
)
logger = logging.getLogger(__name__)

MOSCOW_LAT = 55.7558
MOSCOW_LON = 37.6176
DATABASE_PATH = Path(__file__).with_name("bot_data.sqlite3")
ADMIN_STATE_AWAITING_BROADCAST = "awaiting_broadcast"
DEFAULT_COMMANDS = [
    ("start", "Главное меню"),
    ("help", "Список команд"),
    ("weather", "Погода сейчас"),
    ("today", "Погода на сегодня"),
    ("week", "Прогноз на 7 дней"),
    ("admin", "Админ-панель"),
    ("cancel", "Отменить режим"),
]


def initialize_database() -> None:
    with sqlite3.connect(DATABASE_PATH) as connection:
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS users (
                chat_id INTEGER PRIMARY KEY,
                added_at TEXT NOT NULL
            )
            """
        )
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS admin_state (
                admin_id INTEGER PRIMARY KEY,
                state TEXT NOT NULL
            )
            """
        )
        connection.commit()


initialize_database()


def db_connection() -> sqlite3.Connection:
    connection = sqlite3.connect(DATABASE_PATH)
    connection.row_factory = sqlite3.Row
    return connection


def record_user(chat_id: int) -> None:
    with db_connection() as connection:
        connection.execute(
            "INSERT OR IGNORE INTO users (chat_id, added_at) VALUES (?, datetime('now'))",
            (chat_id,),
        )
        connection.commit()


def remove_user(chat_id: int) -> None:
    with db_connection() as connection:
        connection.execute("DELETE FROM users WHERE chat_id = ?", (chat_id,))
        connection.commit()


def list_users() -> list[int]:
    with db_connection() as connection:
        rows = connection.execute("SELECT chat_id FROM users ORDER BY chat_id ASC").fetchall()
    return [int(row["chat_id"]) for row in rows]


def count_users() -> int:
    with db_connection() as connection:
        row = connection.execute("SELECT COUNT(*) AS count FROM users").fetchone()
    return int(row["count"] if row else 0)


def set_admin_state(admin_id: int, state: str) -> None:
    with db_connection() as connection:
        connection.execute(
            "INSERT INTO admin_state (admin_id, state) VALUES (?, ?) "
            "ON CONFLICT(admin_id) DO UPDATE SET state = excluded.state",
            (admin_id, state),
        )
        connection.commit()


def clear_admin_state(admin_id: int) -> None:
    with db_connection() as connection:
        connection.execute("DELETE FROM admin_state WHERE admin_id = ?", (admin_id,))
        connection.commit()


def get_admin_state(admin_id: int) -> str | None:
    with db_connection() as connection:
        row = connection.execute("SELECT state FROM admin_state WHERE admin_id = ?", (admin_id,)).fetchone()
    return str(row["state"]) if row else None


def parse_admin_ids() -> set[str]:
    raw = (
        os.getenv("ADMIN_TELEGRAM_USER_IDS")
        or os.getenv("ADMIN_TELEGRAM_USER_ID")
        or os.getenv("ADMIN_USER_IDS")
        or ""
    )
    return {value.strip() for value in raw.replace(";", ",").replace(" ", ",").split(",") if value.strip()}


def is_admin(user_id: int | None) -> bool:
    if user_id is None:
        return False
    return str(user_id) in parse_admin_ids()


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


def outfit_recommendation(weather: dict) -> str:
    effective_temp = weather["feelsLike"] if weather.get("feelsLike") is not None else weather.get("temperature")
    if effective_temp is None:
        return "Не могу дать рекомендацию по одежде: нет данных о температуре."

    rainy_or_snowing = weather.get("weatherCode") in {51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 71, 73, 75, 77, 80, 81, 82, 85, 86}

    if effective_temp <= -15:
        recommendation = "Очень холодно: теплая зимняя куртка, шапка, шарф, перчатки, термобелье и теплые ботинки."
    elif effective_temp <= -5:
        recommendation = "Холодно: зимняя куртка, шапка и перчатки."
    elif effective_temp <= 5:
        recommendation = "Прохладно: демисезонная куртка, свитер, закрытая обувь."
    elif effective_temp <= 12:
        recommendation = "Свежо: легкая куртка или ветровка, кофта, кроссовки."
    elif effective_temp <= 20:
        recommendation = "Комфортно: худи или легкая кофта, джинсы или брюки."
    elif effective_temp <= 27:
        recommendation = "Тепло: футболка, легкие брюки или шорты."
    else:
        recommendation = "Жарко: легкая светлая одежда, головной убор и вода с собой."

    notes = []
    if weather.get("wind") is not None and weather["wind"] >= 10:
        notes.append("На улице ветрено, лучше надеть непродуваемый верх.")
    if rainy_or_snowing:
        notes.append("Есть осадки, возьми зонт и непромокаемую обувь.")

    return f"{recommendation} {' '.join(notes)}" if notes else recommendation


def format_timestamp(value: str | None) -> str:
    if not value:
        return "неизвестно"
    normalized = value.replace(" ", "T")
    try:
        date_part, time_part = normalized.split("T", 1)
        year, month, day = date_part.split("-")
        hour, minute = time_part.split(":", 1)
        return f"{day}.{month}.{year} {hour}:{minute[:2]}"
    except ValueError:
        return value


def format_date_only(value: str | None) -> str:
    if not value:
        return "неизвестно"
    try:
        year, month, day = value.split("-")
        return f"{day}.{month}.{year}"
    except ValueError:
        return value


def format_number(value: float | int | None) -> str:
    if value is None:
        return "н/д"
    try:
        numeric = float(value)
    except (TypeError, ValueError):
        return "н/д"
    if numeric.is_integer():
        return str(int(numeric))
    return f"{numeric:.1f}"


def normalize_command(text: str) -> str:
    return text.split()[0].split("@")[0].lstrip("/").lower()


def remember_private_user(update: Update) -> None:
    message = update.effective_message
    if message and message.chat and message.chat.type == "private":
        record_user(message.chat_id)


def weekday_label(date_string: str) -> str:
    try:
        parsed = datetime.fromisoformat(f"{date_string}T12:00:00+03:00")
        return parsed.strftime("%a")
    except ValueError:
        return date_string


def admin_keyboard() -> InlineKeyboardMarkup:
    return InlineKeyboardMarkup(
        [[
            InlineKeyboardButton("Статистика", callback_data="admin_stats"),
            InlineKeyboardButton("Рассылка", callback_data="admin_broadcast"),
        ]]
    )


def admin_broadcast_keyboard() -> InlineKeyboardMarkup:
    return InlineKeyboardMarkup([[InlineKeyboardButton("Отменить", callback_data="admin_cancel")]])


def format_admin_panel(user_count: int) -> str:
    return (
        f"Админ-панель\n\n"
        f"Пользователей: {user_count}\n\n"
        f"Кнопки ниже позволяют посмотреть статистику и запустить рассылку."
    )


def get_moscow_forecast() -> dict:
    url = "https://api.open-meteo.com/v1/forecast"
    params = {
        "latitude": MOSCOW_LAT,
        "longitude": MOSCOW_LON,
        "current": "temperature_2m,apparent_temperature,relative_humidity_2m,wind_speed_10m,weather_code",
        "hourly": "temperature_2m,apparent_temperature,weather_code,precipitation_probability,wind_speed_10m",
        "daily": "weather_code,temperature_2m_max,temperature_2m_min,apparent_temperature_max,apparent_temperature_min,precipitation_probability_max,wind_speed_10m_max",
        "forecast_days": 7,
        "timezone": "Europe/Moscow",
    }

    response = requests.get(url, params=params, timeout=20)
    response.raise_for_status()
    data = response.json()

    current = data.get("current")
    daily = data.get("daily")
    hourly = data.get("hourly")
    if not current or not daily or not hourly:
        raise ValueError("Open-Meteo response is missing forecast data")

    return {
        "current": {
            "temperature": current.get("temperature_2m"),
            "feelsLike": current.get("apparent_temperature"),
            "humidity": current.get("relative_humidity_2m"),
            "wind": current.get("wind_speed_10m"),
            "weatherCode": current.get("weather_code"),
            "time": current.get("time"),
        },
        "daily": {
            "time": daily.get("time", []),
            "weatherCode": daily.get("weather_code", []),
            "temperatureMin": daily.get("temperature_2m_min", []),
            "temperatureMax": daily.get("temperature_2m_max", []),
            "feelsLikeMin": daily.get("apparent_temperature_min", []),
            "feelsLikeMax": daily.get("apparent_temperature_max", []),
            "precipitationProbabilityMax": daily.get("precipitation_probability_max", []),
            "windMax": daily.get("wind_speed_10m_max", []),
        },
        "hourly": {
            "time": hourly.get("time", []),
            "temperature": hourly.get("temperature_2m", []),
            "feelsLike": hourly.get("apparent_temperature", []),
            "weatherCode": hourly.get("weather_code", []),
            "precipitationProbability": hourly.get("precipitation_probability", []),
            "wind": hourly.get("wind_speed_10m", []),
        },
    }


def format_hourly_point(weather: dict, date: str, hour: str, label: str) -> str | None:
    target_prefix = f"{date}T{hour}:"
    try:
        index = next(i for i, value in enumerate(weather["hourly"]["time"]) if value.startswith(target_prefix))
    except StopIteration:
        return None

    temp = weather["hourly"]["temperature"][index]
    feels_like = weather["hourly"]["feelsLike"][index]
    code = weather["hourly"]["weatherCode"][index]
    precipitation = weather["hourly"]["precipitationProbability"][index]
    wind = weather["hourly"]["wind"][index]

    return (
        f"{label} {hour}:00 - {weather_code_to_text(code)}, {format_number(temp)}°C, "
        f"ощущается {format_number(feels_like)}°C, осадки {format_number(precipitation)}%, "
        f"ветер {format_number(wind)} м/с"
    )


async def send_main_menu(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    remember_private_user(update)
    await update.message.reply_text(
        "Привет! Я бот погоды по Москве.\n"
        "Команды:\n"
        "/weather - текущая погода\n"
        "/today - погода на сегодня\n"
        "/week - прогноз на 7 дней\n"
        "/admin - админ-панель\n"
        "/help - помощь"
    )


async def help_command(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    remember_private_user(update)
    await update.message.reply_text(
        "Доступные команды:\n"
        "/weather - текущая погода\n"
        "/today - погода на сегодня\n"
        "/week - прогноз на 7 дней\n"
        "/admin - админ-панель\n"
        "/cancel - отменить режим рассылки"
    )


async def weather_command(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    remember_private_user(update)
    await send_current_weather(update, context)


async def today_command(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    remember_private_user(update)
    await send_today_forecast(update, context)


async def week_command(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    remember_private_user(update)
    await send_week_forecast(update, context)


async def admin_command(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    remember_private_user(update)
    message = update.effective_message
    user_id = update.effective_user.id if update.effective_user else None
    chat_id = message.chat_id if message else None

    if chat_id is None:
        return

    if not is_admin(user_id):
        await message.reply_text("У тебя нет доступа к админ-панели.")
        return

    await message.reply_text(format_admin_panel(count_users()), reply_markup=admin_keyboard())


async def cancel_command(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    remember_private_user(update)
    user_id = update.effective_user.id if update.effective_user else None
    chat_id = update.effective_message.chat_id if update.effective_message else None

    if user_id is not None:
        clear_admin_state(user_id)
    if chat_id is not None:
        await update.effective_message.reply_text("Режим рассылки отменен.")


async def handle_admin_callback(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    query = update.callback_query
    if not query or not query.message:
        return

    user_id = query.from_user.id if query.from_user else None
    chat_id = query.message.chat_id
    message_id = query.message.message_id
    data = query.data or ""

    if not is_admin(user_id):
        await query.answer("У тебя нет доступа к админ-панели", show_alert=True)
        return

    if data == "admin_stats":
        user_count = count_users()
        await query.answer(f"Пользователей: {user_count}")
        await context.bot.edit_message_text(
            chat_id=chat_id,
            message_id=message_id,
            text=f"{format_admin_panel(user_count)}\n\nПользователей: {user_count}",
            reply_markup=admin_keyboard(),
        )
        return

    if data == "admin_broadcast":
        if user_id is not None:
            set_admin_state(user_id, ADMIN_STATE_AWAITING_BROADCAST)
        await query.answer("Отправь сообщение для рассылки")
        await context.bot.edit_message_text(
            chat_id=chat_id,
            message_id=message_id,
            text=f"{format_admin_panel(count_users())}\n\nРежим рассылки включен. Отправь любое сообщение, и я разошлю его всем пользователям.",
            reply_markup=admin_broadcast_keyboard(),
        )
        return

    if data == "admin_cancel":
        if user_id is not None:
            clear_admin_state(user_id)
        await query.answer("Отменено")
        await context.bot.edit_message_text(
            chat_id=chat_id,
            message_id=message_id,
            text=format_admin_panel(count_users()),
            reply_markup=admin_keyboard(),
        )
        return

    await query.answer("Неизвестное действие")


async def send_current_weather(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    message = update.effective_message
    if not message:
        return

    try:
        weather = get_moscow_forecast()
    except Exception as exc:
        logger.exception("Failed to fetch current weather: %s", exc)
        await message.reply_text("Не удалось получить погоду. Попробуй чуть позже.")
        return

    current = weather["current"]
    recommendation = outfit_recommendation(current)
    weather_text = weather_code_to_text(current["weatherCode"])
    text = (
        "Погода в Москве сейчас:\n"
        f"- Обновлено: {format_timestamp(current['time'])}\n"
        f"- Состояние: {weather_text}\n"
        f"- Температура: {format_number(current['temperature'])}°C\n"
        f"- Ощущается как: {format_number(current['feelsLike'])}°C\n"
        f"- Влажность: {format_number(current['humidity'])}%\n"
        f"- Ветер: {format_number(current['wind'])} м/с\n\n"
        f"Рекомендация: {recommendation}"
    )
    await message.reply_text(text)


async def send_today_forecast(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    message = update.effective_message
    if not message:
        return

    try:
        weather = get_moscow_forecast()
    except Exception as exc:
        logger.exception("Failed to fetch today forecast: %s", exc)
        await message.reply_text("Не удалось получить прогноз на сегодня. Попробуй позже.")
        return

    today = weather["daily"]["time"][0]
    segments = [
        format_hourly_point(weather, today, "00", "Ночь"),
        format_hourly_point(weather, today, "06", "Утро"),
        format_hourly_point(weather, today, "12", "День"),
        format_hourly_point(weather, today, "18", "Вечер"),
    ]
    segments = [segment for segment in segments if segment]

    text = [
        f"Погода в Москве на сегодня, {format_date_only(today)}:",
        f"- Сводка: {weather_code_to_text(weather['daily']['weatherCode'][0])}",
        f"- Температура: {format_number(weather['daily']['temperatureMin'][0])}...{format_number(weather['daily']['temperatureMax'][0])}°C",
        f"- Ощущается как: {format_number(weather['daily']['feelsLikeMin'][0])}...{format_number(weather['daily']['feelsLikeMax'][0])}°C",
        f"- Вероятность осадков: {format_number(weather['daily']['precipitationProbabilityMax'][0])}%",
        f"- Максимальный ветер: {format_number(weather['daily']['windMax'][0])} м/с",
        "",
        "По часам:",
        *segments,
    ]
    await message.reply_text("\n".join(text))


async def send_week_forecast(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    message = update.effective_message
    if not message:
        return

    try:
        weather = get_moscow_forecast()
    except Exception as exc:
        logger.exception("Failed to fetch week forecast: %s", exc)
        await message.reply_text("Не удалось получить прогноз на 7 дней. Попробуй позже.")
        return

    lines = []
    for index, date in enumerate(weather["daily"]["time"]):
        lines.append(
            "\n".join(
                [
                    f"{weekday_label(date)} ({format_date_only(date)}): {weather_code_to_text(weather['daily']['weatherCode'][index])}",
                    f"  {format_number(weather['daily']['temperatureMin'][index])}...{format_number(weather['daily']['temperatureMax'][index])}°C, ощущается {format_number(weather['daily']['feelsLikeMin'][index])}...{format_number(weather['daily']['feelsLikeMax'][index])}°C",
                    f"  Осадки: {format_number(weather['daily']['precipitationProbabilityMax'][index])}%, ветер до {format_number(weather['daily']['windMax'][index])} м/с",
                ]
            )
        )

    await message.reply_text("\n\n".join(["Прогноз на 7 дней:", *lines]))


async def handle_non_command_message(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    message = update.effective_message
    user = update.effective_user
    if not message or not user:
        return

    if message.chat.type == "private":
        record_user(message.chat_id)

    if get_admin_state(user.id) == ADMIN_STATE_AWAITING_BROADCAST:
        await broadcast_message(message, context)
        return

    if message.text:
        await message.reply_text("Используй /help, чтобы посмотреть доступные команды.")


async def broadcast_message(message, context: ContextTypes.DEFAULT_TYPE) -> None:
    user = message.from_user
    if not user or not is_admin(user.id):
        await message.reply_text("У тебя нет доступа к админ-панели.")
        return

    recipients = [chat_id for chat_id in list_users() if chat_id != message.chat_id]
    success = 0
    failed = 0

    for target_chat_id in recipients:
        try:
            await context.bot.copy_message(
                chat_id=target_chat_id,
                from_chat_id=message.chat_id,
                message_id=message.message_id,
            )
            success += 1
        except Exception as exc:
            failed += 1
            logger.warning("Broadcast failed for %s: %s", target_chat_id, exc)
            remove_user(target_chat_id)

    clear_admin_state(user.id)
    await message.reply_text(f"Рассылка завершена. Отправлено: {success}. Ошибок: {failed}.")


async def post_init(application: Application) -> None:
    await application.bot.set_my_commands([BotCommand(command, description) for command, description in DEFAULT_COMMANDS])


def main() -> None:
    token = os.getenv("TELEGRAM_BOT_TOKEN")
    if not token:
        raise RuntimeError("TELEGRAM_BOT_TOKEN is not set")

    application = Application.builder().token(token).post_init(post_init).build()
    application.add_handler(CommandHandler("start", send_main_menu))
    application.add_handler(CommandHandler("help", help_command))
    application.add_handler(CommandHandler("weather", weather_command))
    application.add_handler(CommandHandler("today", today_command))
    application.add_handler(CommandHandler("week", week_command))
    application.add_handler(CommandHandler("admin", admin_command))
    application.add_handler(CommandHandler("cancel", cancel_command))
    application.add_handler(CallbackQueryHandler(handle_admin_callback, pattern=r"^admin_"))
    application.add_handler(MessageHandler(filters.ALL & ~filters.COMMAND, handle_non_command_message))

    logger.info("Bot is running with long polling")
    application.run_polling(drop_pending_updates=True)


if __name__ == "__main__":
    main()

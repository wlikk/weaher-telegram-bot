const MOSCOW_LAT = 55.7558;
const MOSCOW_LON = 37.6176;
const ADMIN_STATE_AWAITING_BROADCAST = "awaiting_broadcast";
const DEFAULT_COMMANDS = [
  { command: "start", description: "Главное меню" },
  { command: "help", description: "Список команд" },
  { command: "weather", description: "Погода сейчас" },
  { command: "today", description: "Погода на сегодня" },
  { command: "week", description: "Прогноз на 7 дней" },
  { command: "admin", description: "Админ-панель" },
  { command: "cancel", description: "Отменить режим" },
];

export default {
  async fetch(request, env) {
    if (request.method === "GET") {
      return json({ ok: true, service: "telegram-weather-worker" });
    }

    if (request.method !== "POST") {
      return json({ ok: false, error: "Method not allowed" }, 405);
    }

    try {
      const expectedSecret = env.TELEGRAM_SECRET_TOKEN;
      if (expectedSecret) {
        const receivedSecret = request.headers.get("X-Telegram-Bot-Api-Secret-Token");
        if (!receivedSecret || receivedSecret !== expectedSecret) {
          return json({ ok: false, error: "Forbidden" }, 403);
        }
      }

      await ensureBotCommands(env);
      const update = await request.json();
      await handleTelegramUpdate(update, env);
      return json({ ok: true });
    } catch (error) {
      console.error("Worker error:", error);
      return json({ ok: false, error: "Internal error" }, 500);
    }
  },
};

export class BotStorage {
  constructor(state) {
    this.state = state;
  }

  async fetch(request) {
    const url = new URL(request.url);
    const action = url.pathname.replace(/^\//, "");
    const body = await request.json().catch(() => ({}));

    switch (action) {
      case "add-user": {
        const chatId = body.chatId;
        if (!chatId) {
          return json({ ok: false, error: "chatId is required" }, 400);
        }
        await this.state.storage.put(`user:${chatId}`, { chatId, addedAt: new Date().toISOString() });
        return json({ ok: true });
      }
      case "remove-user": {
        const chatId = body.chatId;
        if (!chatId) {
          return json({ ok: false, error: "chatId is required" }, 400);
        }
        await this.state.storage.delete(`user:${chatId}`);
        return json({ ok: true });
      }
      case "list-users": {
        const entries = await this.state.storage.list({ prefix: "user:" });
        const chatIds = Array.from(entries.keys()).map((key) => Number(key.slice(5))).filter(Number.isFinite);
        return json({ ok: true, chatIds, count: chatIds.length });
      }
      case "set-admin-state": {
        const adminId = body.adminId;
        const state = body.state;
        if (!adminId || !state) {
          return json({ ok: false, error: "adminId and state are required" }, 400);
        }
        await this.state.storage.put(`admin-state:${adminId}`, state);
        return json({ ok: true });
      }
      case "get-admin-state": {
        const adminId = body.adminId;
        if (!adminId) {
          return json({ ok: false, error: "adminId is required" }, 400);
        }
        const state = (await this.state.storage.get(`admin-state:${adminId}`)) || null;
        return json({ ok: true, state });
      }
      case "clear-admin-state": {
        const adminId = body.adminId;
        if (!adminId) {
          return json({ ok: false, error: "adminId is required" }, 400);
        }
        await this.state.storage.delete(`admin-state:${adminId}`);
        return json({ ok: true });
      }
      case "stats": {
        const entries = await this.state.storage.list({ prefix: "user:" });
        const chatIds = Array.from(entries.keys()).map((key) => Number(key.slice(5))).filter(Number.isFinite);
        return json({ ok: true, count: chatIds.length });
      }
      default:
        return json({ ok: false, error: "Unknown action" }, 404);
    }
  }
}

async function handleTelegramUpdate(update, env) {
  if (update?.callback_query) {
    await handleCallbackQuery(update.callback_query, env);
    return;
  }

  const message = update?.message;
  if (!message) return;

  const chatId = message.chat?.id;
  const userId = message.from?.id;
  const text = (message.text || "").trim();

  if (!chatId) return;
  if (message.chat?.type === "private") {
    await recordUser(env, chatId);
  }

  if (text.startsWith("/")) {
    const command = normalizeCommand(text);
    if (command === "start") {
      await sendMainMenu(env, chatId);
      return;
    }
    if (command === "help") {
      await sendTelegramMessage(
        env,
        chatId,
        [
          "Доступные команды:",
          "/weather - текущая погода",
          "/today - погода на сегодня",
          "/week - прогноз на 7 дней",
          "/admin - админ-панель",
          "/cancel - отменить режим рассылки",
        ].join("\n")
      );
      return;
    }
    if (command === "weather") {
      await sendCurrentWeather(env, chatId);
      return;
    }
    if (command === "today") {
      await sendTodayForecast(env, chatId);
      return;
    }
    if (command === "week") {
      await sendWeekForecast(env, chatId);
      return;
    }
    if (command === "admin") {
      await sendAdminPanel(env, chatId, userId);
      return;
    }
    if (command === "cancel") {
      await clearAdminState(env, userId);
      await sendTelegramMessage(env, chatId, "Режим рассылки отменен.");
      return;
    }

    await sendTelegramMessage(env, chatId, "Команда не распознана. Используй /help.");
    return;
  }

  if (await isAwaitingBroadcast(env, userId)) {
    await broadcastAdminMessage(env, message, chatId, userId);
    return;
  }

  if (text) {
    await sendTelegramMessage(env, chatId, "Используй /help, чтобы посмотреть доступные команды.");
  }
}

async function handleCallbackQuery(callbackQuery, env) {
  const data = callbackQuery.data;
  const chatId = callbackQuery.message?.chat?.id;
  const messageId = callbackQuery.message?.message_id;
  const userId = callbackQuery.from?.id;

  if (!chatId || !messageId) {
    return;
  }

  if (!isAdminUser(userId, env)) {
    await answerCallbackQuery(env, callbackQuery.id, "У тебя нет доступа к админ-панели");
    return;
  }

  if (data === "admin_stats") {
    const stats = await getBotStats(env);
    await answerCallbackQuery(env, callbackQuery.id, `Пользователей: ${stats.count}`);
    await editTelegramMessage(
      env,
      chatId,
      messageId,
      `${formatAdminPanel(stats.count)}\n\nПользователей: ${stats.count}`,
      adminKeyboard()
    );
    return;
  }

  if (data === "admin_broadcast") {
    await setAdminState(env, userId, ADMIN_STATE_AWAITING_BROADCAST);
    await answerCallbackQuery(env, callbackQuery.id, "Отправь сообщение для рассылки");
    const stats = await getBotStats(env);
    await editTelegramMessage(
      env,
      chatId,
      messageId,
      `${formatAdminPanel(stats.count)}\n\nРежим рассылки включен. Отправь любое сообщение, и я разошлю его всем пользователям.`,
      adminBroadcastKeyboard()
    );
    return;
  }

  if (data === "admin_cancel") {
    await clearAdminState(env, userId);
    await answerCallbackQuery(env, callbackQuery.id, "Отменено");
    const stats = await getBotStats(env);
    await editTelegramMessage(env, chatId, messageId, formatAdminPanel(stats.count), adminKeyboard());
    return;
  }

  await answerCallbackQuery(env, callbackQuery.id, "Неизвестное действие");
}

async function sendMainMenu(env, chatId) {
  await sendTelegramMessage(
    env,
    chatId,
    [
      "Привет! Я бот погоды по Москве.",
      "Команды:",
      "/weather - текущая погода",
      "/today - погода на сегодня",
      "/week - прогноз на 7 дней",
      "/admin - админ-панель",
      "/help - помощь",
    ].join("\n")
  );
}

async function sendCurrentWeather(env, chatId) {
  try {
    const weather = await getMoscowForecast();
    const recommendation = outfitRecommendation(weather.current);
    const weatherText = weatherCodeToText(weather.current.weatherCode);
    const msg =
      `Погода в Москве сейчас:\n` +
      `- Обновлено: ${formatTimestamp(weather.current.time)}\n` +
      `- Состояние: ${weatherText}\n` +
      `- Температура: ${formatNumber(weather.current.temperature)}°C\n` +
      `- Ощущается как: ${formatNumber(weather.current.feelsLike)}°C\n` +
      `- Влажность: ${formatNumber(weather.current.humidity)}%\n` +
      `- Ветер: ${formatNumber(weather.current.wind)} м/с\n\n` +
      `Рекомендация: ${recommendation}`;

    await sendTelegramMessage(env, chatId, msg);
  } catch (error) {
    console.error("Weather error:", error);
    await sendTelegramMessage(env, chatId, "Не удалось получить погоду. Попробуй чуть позже.");
  }
}

async function sendTodayForecast(env, chatId) {
  try {
    const weather = await getMoscowForecast();
    const today = weather.daily.time[0];
    const summary = weather.daily.weatherCode[0];
    const segments = [
      ["Ночь", "00"],
      ["Утро", "06"],
      ["День", "12"],
      ["Вечер", "18"],
    ]
      .map(([label, hour]) => formatHourlyPoint(weather, today, hour, label))
      .filter(Boolean);

    const message = [
      `Погода в Москве на сегодня, ${formatDateOnly(today)}:`,
      `- Сводка: ${weatherCodeToText(summary)}`,
      `- Температура: ${formatNumber(weather.daily.temperatureMin[0])}...${formatNumber(weather.daily.temperatureMax[0])}°C`,
      `- Ощущается как: ${formatNumber(weather.daily.feelsLikeMin[0])}...${formatNumber(weather.daily.feelsLikeMax[0])}°C`,
      `- Вероятность осадков: ${formatNumber(weather.daily.precipitationProbabilityMax[0])}%`,
      `- Максимальный ветер: ${formatNumber(weather.daily.windMax[0])} м/с`,
      "",
      "По часам:",
      ...segments,
    ].join("\n");

    await sendTelegramMessage(env, chatId, message);
  } catch (error) {
    console.error("Today forecast error:", error);
    await sendTelegramMessage(env, chatId, "Не удалось получить прогноз на сегодня. Попробуй позже.");
  }
}

async function sendWeekForecast(env, chatId) {
  try {
    const weather = await getMoscowForecast();
    const lines = weather.daily.time.map((date, index) => {
      const dayName = weekdayLabel(date);
      const weatherText = weatherCodeToText(weather.daily.weatherCode[index]);
      return [
        `${dayName} (${formatDateOnly(date)}): ${weatherText}`,
        `  ${formatNumber(weather.daily.temperatureMin[index])}...${formatNumber(weather.daily.temperatureMax[index])}°C, ощущается ${formatNumber(weather.daily.feelsLikeMin[index])}...${formatNumber(weather.daily.feelsLikeMax[index])}°C`,
        `  Осадки: ${formatNumber(weather.daily.precipitationProbabilityMax[index])}%, ветер до ${formatNumber(weather.daily.windMax[index])} м/с`,
      ].join("\n");
    });

    await sendTelegramMessage(env, chatId, ["Прогноз на 7 дней:", ...lines].join("\n\n"));
  } catch (error) {
    console.error("Week forecast error:", error);
    await sendTelegramMessage(env, chatId, "Не удалось получить прогноз на 7 дней. Попробуй позже.");
  }
}

async function sendAdminPanel(env, chatId, userId) {
  if (!isAdminUser(userId, env)) {
    await sendTelegramMessage(env, chatId, "У тебя нет доступа к админ-панели.");
    return;
  }

  const stats = await getBotStats(env);
  await sendTelegramMessage(env, chatId, formatAdminPanel(stats.count), adminKeyboard());
}

async function broadcastAdminMessage(env, message, chatId, userId) {
  if (!isAdminUser(userId, env)) {
    await sendTelegramMessage(env, chatId, "У тебя нет доступа к админ-панели.");
    return;
  }

  const users = (await listUsers(env)).filter((targetChatId) => targetChatId !== chatId);
  let success = 0;
  let failed = 0;

  for (const targetChatId of users) {
    try {
      await copyTelegramMessage(env, targetChatId, chatId, message.message_id);
      success += 1;
    } catch (error) {
      failed += 1;
      console.warn(`Broadcast failed for ${targetChatId}:`, error);
      await removeUser(env, targetChatId);
    }
  }

  await clearAdminState(env, userId);
  await sendTelegramMessage(env, chatId, `Рассылка завершена. Отправлено: ${success}. Ошибок: ${failed}.`);
}

async function ensureBotCommands(env) {
  await telegramApi(env, "setMyCommands", { commands: DEFAULT_COMMANDS });
}

async function getMoscowForecast() {
  const params = new URLSearchParams({
    latitude: String(MOSCOW_LAT),
    longitude: String(MOSCOW_LON),
    current: "temperature_2m,apparent_temperature,relative_humidity_2m,wind_speed_10m,weather_code",
    hourly: "temperature_2m,apparent_temperature,weather_code,precipitation_probability,wind_speed_10m",
    daily: "weather_code,temperature_2m_max,temperature_2m_min,apparent_temperature_max,apparent_temperature_min,precipitation_probability_max,wind_speed_10m_max",
    forecast_days: "7",
    timezone: "Europe/Moscow",
  });

  const res = await fetch(`https://api.open-meteo.com/v1/forecast?${params.toString()}`);
  if (!res.ok) {
    throw new Error(`Open-Meteo HTTP ${res.status}`);
  }

  const data = await res.json();
  const current = data?.current;
  const daily = data?.daily;
  const hourly = data?.hourly;

  if (!current || !daily || !hourly) {
    throw new Error("Open-Meteo response is missing forecast data");
  }

  return {
    current: {
      temperature: current.temperature_2m,
      feelsLike: current.apparent_temperature,
      humidity: current.relative_humidity_2m,
      wind: current.wind_speed_10m,
      weatherCode: current.weather_code,
      time: current.time,
    },
    daily: {
      time: daily.time || [],
      weatherCode: daily.weather_code || [],
      temperatureMin: daily.temperature_2m_min || [],
      temperatureMax: daily.temperature_2m_max || [],
      feelsLikeMin: daily.apparent_temperature_min || [],
      feelsLikeMax: daily.apparent_temperature_max || [],
      precipitationProbabilityMax: daily.precipitation_probability_max || [],
      windMax: daily.wind_speed_10m_max || [],
    },
    hourly: {
      time: hourly.time || [],
      temperature: hourly.temperature_2m || [],
      feelsLike: hourly.apparent_temperature || [],
      weatherCode: hourly.weather_code || [],
      precipitationProbability: hourly.precipitation_probability || [],
      wind: hourly.wind_speed_10m || [],
    },
  };
}

function weatherCodeToText(code) {
  const mapping = {
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
  };
  return mapping[code] || "Неизвестно";
}

function outfitRecommendation(weather) {
  const effectiveTemp = Number.isFinite(weather.feelsLike) ? weather.feelsLike : weather.temperature;
  const rainyOrSnowing = new Set([51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 71, 73, 75, 77, 80, 81, 82, 85, 86]).has(weather.weatherCode);

  let recommendation;
  if (effectiveTemp <= -15) {
    recommendation = "Очень холодно: теплая зимняя куртка, шапка, шарф, перчатки, термобелье и теплые ботинки.";
  } else if (effectiveTemp <= -5) {
    recommendation = "Холодно: зимняя куртка, шапка и перчатки.";
  } else if (effectiveTemp <= 5) {
    recommendation = "Прохладно: демисезонная куртка, свитер, закрытая обувь.";
  } else if (effectiveTemp <= 12) {
    recommendation = "Свежо: легкая куртка или ветровка, кофта, кроссовки.";
  } else if (effectiveTemp <= 20) {
    recommendation = "Комфортно: худи или легкая кофта, джинсы или брюки.";
  } else if (effectiveTemp <= 27) {
    recommendation = "Тепло: футболка, легкие брюки или шорты.";
  } else {
    recommendation = "Жарко: легкая светлая одежда, головной убор и вода с собой.";
  }

  const notes = [];
  if (Number.isFinite(weather.wind) && weather.wind >= 10) {
    notes.push("На улице ветрено, лучше надеть непродуваемый верх.");
  }
  if (rainyOrSnowing) {
    notes.push("Есть осадки, возьми зонт и непромокаемую обувь.");
  }

  return notes.length ? `${recommendation} ${notes.join(" ")}` : recommendation;
}

function formatHourlyPoint(weather, date, hour, label) {
  const index = weather.hourly.time.findIndex((time) => time.startsWith(`${date}T${hour}:`));
  if (index === -1) {
    return null;
  }

  const temp = weather.hourly.temperature[index];
  const feelsLike = weather.hourly.feelsLike[index];
  const code = weather.hourly.weatherCode[index];
  const precipitation = weather.hourly.precipitationProbability[index];
  const wind = weather.hourly.wind[index];

  return `${label} ${hour}:00 - ${weatherCodeToText(code)}, ${formatNumber(temp)}°C, ощущается ${formatNumber(feelsLike)}°C, осадки ${formatNumber(precipitation)}%, ветер ${formatNumber(wind)} м/с`;
}

function weekdayLabel(dateString) {
  const date = new Date(`${dateString}T12:00:00+03:00`);
  if (Number.isNaN(date.getTime())) {
    return dateString;
  }

  return new Intl.DateTimeFormat("ru-RU", { weekday: "short", timeZone: "Europe/Moscow" }).format(date);
}

function formatDateOnly(value) {
  if (!value || typeof value !== "string") {
    return "неизвестно";
  }
  const [datePart] = value.split("T");
  const [year, month, day] = datePart.split("-");
  if (!year || !month || !day) {
    return value;
  }
  return `${day}.${month}.${year}`;
}

function formatTimestamp(value) {
  if (!value || typeof value !== "string") {
    return "неизвестно";
  }
  const normalized = value.replace(" ", "T");
  const [datePart, timePart = ""] = normalized.split("T");
  const [year, month, day] = datePart.split("-");
  const [hour = "00", minute = "00"] = timePart.split(":");
  if (!year || !month || !day) {
    return value;
  }
  return `${day}.${month}.${year} ${hour}:${minute.slice(0, 2)}`;
}

function formatNumber(value) {
  if (!Number.isFinite(value)) {
    return "н/д";
  }
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function normalizeCommand(text) {
  return text.split(/\s+/, 1)[0].split("@")[0].slice(1).toLowerCase();
}

function adminKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: "Статистика", callback_data: "admin_stats" },
        { text: "Рассылка", callback_data: "admin_broadcast" },
      ],
    ],
  };
}

function adminBroadcastKeyboard() {
  return {
    inline_keyboard: [[{ text: "Отменить", callback_data: "admin_cancel" }]],
  };
}

function formatAdminPanel(userCount) {
  return `Админ-панель\n\nПользователей: ${userCount}\n\nКнопки ниже позволяют посмотреть статистику и запустить рассылку.`;
}

function isAdminUser(userId, env) {
  return parseAdminIds(env).has(String(userId));
}

function parseAdminIds(env) {
  const raw = env.ADMIN_TELEGRAM_USER_IDS || env.ADMIN_TELEGRAM_USER_ID || env.ADMIN_USER_IDS || "";
  return new Set(
    raw
      .split(/[,\s]+/)
      .map((value) => value.trim())
      .filter(Boolean)
  );
}

async function recordUser(env, chatId) {
  await storageRequest(env, "add-user", { chatId });
}

async function removeUser(env, chatId) {
  await storageRequest(env, "remove-user", { chatId });
}

async function listUsers(env) {
  const result = await storageRequest(env, "list-users", {});
  return result.chatIds || [];
}

async function getBotStats(env) {
  const result = await storageRequest(env, "stats", {});
  return { count: result.count || 0 };
}

async function setAdminState(env, adminId, state) {
  await storageRequest(env, "set-admin-state", { adminId, state });
}

async function getAdminState(env, adminId) {
  const result = await storageRequest(env, "get-admin-state", { adminId });
  return result.state || null;
}

async function clearAdminState(env, adminId) {
  await storageRequest(env, "clear-admin-state", { adminId });
}

async function isAwaitingBroadcast(env, userId) {
  if (!userId) {
    return false;
  }
  return (await getAdminState(env, userId)) === ADMIN_STATE_AWAITING_BROADCAST;
}

async function storageRequest(env, action, body) {
  if (!env.BOT_STATE) {
    throw new Error("BOT_STATE durable object is not configured");
  }

  const stub = env.BOT_STATE.get(env.BOT_STATE.idFromName("global"));
  const response = await stub.fetch(`https://bot-state/${action}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Storage action ${action} failed: ${response.status} ${text}`);
  }

  return response.json();
}

async function telegramApi(env, method, payload) {
  const token = env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    throw new Error("TELEGRAM_BOT_TOKEN is not set");
  }

  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Telegram ${method} failed: ${response.status} ${body}`);
  }

  return response.json();
}

async function sendTelegramMessage(env, chatId, text, replyMarkup) {
  await telegramApi(env, "sendMessage", {
    chat_id: chatId,
    text,
    reply_markup: replyMarkup,
  });
}

async function editTelegramMessage(env, chatId, messageId, text, replyMarkup) {
  await telegramApi(env, "editMessageText", {
    chat_id: chatId,
    message_id: messageId,
    text,
    reply_markup: replyMarkup,
  });
}

async function copyTelegramMessage(env, chatId, fromChatId, messageId) {
  await telegramApi(env, "copyMessage", {
    chat_id: chatId,
    from_chat_id: fromChatId,
    message_id: messageId,
  });
}

async function answerCallbackQuery(env, callbackQueryId, text) {
  await telegramApi(env, "answerCallbackQuery", {
    callback_query_id: callbackQueryId,
    text,
  });
}

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

const MOSCOW_LAT = 55.7558;
const MOSCOW_LON = 37.6176;

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

      const update = await request.json();
      await handleTelegramUpdate(update, env);
      return json({ ok: true });
    } catch (error) {
      console.error("Worker error:", error);
      return json({ ok: false, error: "Internal error" }, 500);
    }
  },
};

async function handleTelegramUpdate(update, env) {
  const message = update?.message;
  if (!message) return;

  const chatId = message.chat?.id;
  const text = (message.text || "").trim();
  if (!chatId || !text) return;

  if (text === "/start") {
    await sendTelegramMessage(
      env,
      chatId,
      "Привет! Я бот погоды по Москве. Команды:\n/weather - текущая погода и совет по одежде\n/help - помощь"
    );
    return;
  }

  if (text === "/help") {
    await sendTelegramMessage(
      env,
      chatId,
      "Используй /weather чтобы получить погоду в Москве и рекомендацию по одежде."
    );
    return;
  }

  if (text === "/weather") {
    try {
      const weather = await getMoscowWeather();
      const recommendation = outfitRecommendation(weather);
      const weatherText = weatherCodeToText(weather.weatherCode);
      const msg =
        `Погода в Москве на ${formatDate(weather.time)}:\n` +
        `- Состояние: ${weatherText}\n` +
        `- Температура: ${weather.temperature}°C\n` +
        `- Ощущается как: ${weather.feelsLike}°C\n` +
        `- Влажность: ${weather.humidity}%\n` +
        `- Ветер: ${weather.wind} м/с\n\n` +
        `Рекомендация: ${recommendation}`;

      await sendTelegramMessage(env, chatId, msg);
    } catch (error) {
      console.error("Weather error:", error);
      await sendTelegramMessage(env, chatId, "Не удалось получить погоду. Попробуй чуть позже.");
    }
    return;
  }

  await sendTelegramMessage(env, chatId, "Команда не распознана. Используй /weather");
}

async function getMoscowWeather() {
  const params = new URLSearchParams({
    latitude: String(MOSCOW_LAT),
    longitude: String(MOSCOW_LON),
    current: "temperature_2m,apparent_temperature,relative_humidity_2m,wind_speed_10m,weather_code",
    timezone: "Europe/Moscow",
  });

  const res = await fetch(`https://api.open-meteo.com/v1/forecast?${params.toString()}`);
  if (!res.ok) {
    throw new Error(`Open-Meteo HTTP ${res.status}`);
  }

  const data = await res.json();
  const current = data?.current;
  if (!current) {
    throw new Error("No current weather in Open-Meteo response");
  }

  return {
    temperature: current.temperature_2m,
    feelsLike: current.apparent_temperature,
    humidity: current.relative_humidity_2m,
    wind: current.wind_speed_10m,
    weatherCode: current.weather_code,
    time: current.time,
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
  const code = weather.weatherCode;
  const rainingOrSnowing = new Set([
    51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 71, 73, 75, 77, 80, 81, 82, 85, 86,
  ]).has(code);

  let rec = "";
  if (effectiveTemp <= -15) {
    rec = "Очень холодно: теплая зимняя куртка, шапка, шарф, перчатки, термобелье и теплые ботинки.";
  } else if (effectiveTemp <= -5) {
    rec = "Холодно: зимняя куртка, шапка и перчатки.";
  } else if (effectiveTemp <= 5) {
    rec = "Прохладно: демисезонная куртка, свитер, закрытая обувь.";
  } else if (effectiveTemp <= 12) {
    rec = "Свежо: легкая куртка или ветровка, кофта, кроссовки.";
  } else if (effectiveTemp <= 20) {
    rec = "Комфортно: худи или легкая кофта, джинсы или брюки.";
  } else if (effectiveTemp <= 27) {
    rec = "Тепло: футболка, легкие брюки или шорты.";
  } else {
    rec = "Жарко: легкая светлая одежда, головной убор и вода с собой.";
  }

  const notes = [];
  if (Number.isFinite(weather.wind) && weather.wind >= 10) {
    notes.push("На улице ветрено, лучше надеть непродуваемый верх.");
  }
  if (rainingOrSnowing) {
    notes.push("Есть осадки, возьми зонт и непромокаемую обувь.");
  }

  return notes.length > 0 ? `${rec} ${notes.join(" ")}` : rec;
}

async function sendTelegramMessage(env, chatId, text) {
  const token = env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    throw new Error("TELEGRAM_BOT_TOKEN is not set");
  }

  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Telegram sendMessage failed: ${res.status} ${body}`);
  }
}

function formatDate(value) {
  if (!value) return "неизвестно";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;

  const dd = String(date.getDate()).padStart(2, "0");
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const yyyy = date.getFullYear();
  const hh = String(date.getHours()).padStart(2, "0");
  const min = String(date.getMinutes()).padStart(2, "0");
  return `${dd}.${mm}.${yyyy} ${hh}:${min}`;
}

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

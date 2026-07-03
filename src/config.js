'use strict';
require('dotenv').config();
const crypto = require('crypto');

// PAIR_TOKEN: если не задан в env — генерируем случайный на старте процесса.
// Стабилен в пределах запуска (модуль кешируется), поэтому /pair-страница и
// лог туннеля используют один и тот же токен. Т.к. URL Quick-Tunnel'а всё равно
// меняется на каждом рестарте, эфемерный токен здесь уместен — ссылка целиком
// печатается в лог при старте.
const PAIR_TOKEN = process.env.PAIR_TOKEN || crypto.randomBytes(16).toString('hex');

module.exports = {
  // Server
  PORT: parseInt(process.env.PORT || '3000', 10),

  // OpenRouter — остаётся для STT (голос) и Vision (картинки), которых нет у
  // DeepSeek, а также как fallback для текстового агента, если DeepSeek недоступен.
  OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY || '',
  OPENROUTER_MODEL: process.env.OPENROUTER_MODEL || 'deepseek/deepseek-v4-flash',
  // Backup model used only when the primary fails after all retries (provider
  // outage / no response). Set to '' or same as primary to disable.
  OPENROUTER_FALLBACK_MODEL: process.env.OPENROUTER_FALLBACK_MODEL || 'qwen/qwen3.6-plus',
  // DeepSeek (прямой API) — ОСНОВНОЙ текстовый агент + AI-резюме. OpenAI-совместим.
  // Если DEEPSEEK_API_KEY пуст — текстовый агент автоматически работает через
  // OpenRouter (обратная совместимость). Для function calling нужен deepseek-chat
  // (у deepseek-reasoner нет нормального tool calling). STT/Vision DeepSeek НЕ умеет.
  DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY || '',
  DEEPSEEK_BASE_URL: process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com',
  DEEPSEEK_MODEL: process.env.DEEPSEEK_MODEL || 'deepseek-chat',
  // Потолок длины ответа LLM (output tokens). ВАЖНО: без явного лимита OpenRouter
  // резервирует полный лимит модели (напр. 65536) и требует баланс под него → 402
  // «requires more credits». Явный потолок снимает 402 и удешевляет ответы. 32768 —
  // большой запас на длинные планы/отчёты; всё ещё вдвое меньше 65536. Переопределяется.
  // ПРИМЕЧАНИЕ: при почти пустом балансе OpenRouter даже этот лимит может дать 402 —
  // тогда нужно пополнить баланс, а не уменьшать лимит.
  LLM_MAX_TOKENS: parseInt(process.env.LLM_MAX_TOKENS || '32768', 10),

  // STT (распознавание речи) и Vision (распознавание картинок) через OpenRouter.
  // У каждого есть primary + fallback: если primary падает после ретраев —
  // запрос обслуживает fallback-модель.
  STT_MODEL: process.env.STT_MODEL || 'openai/whisper-large-v3-turbo',
  STT_FALLBACK_MODEL: process.env.STT_FALLBACK_MODEL || 'google/chirp-3',
  VISION_MODEL: process.env.VISION_MODEL || 'google/gemini-3.1-flash-lite-preview',
  VISION_FALLBACK_MODEL: process.env.VISION_FALLBACK_MODEL || 'qwen/qwen3.5-flash-02-23',
  // Видео (обычное, кружки, гифки) смотрит Gemini через OpenRouter (content type
  // video_url, base64 data-URL — маршрутизируется в провайдера с поддержкой видео).
  // Дополнительно к описанию Gemini речь из видео транскрибируется Whisper'ом
  // (тот же STT-эндпоинт; mp4-контейнер Whisper понимает).
  VIDEO_MODEL: process.env.VIDEO_MODEL || 'google/gemini-3.1-flash-lite-preview',
  VIDEO_FALLBACK_MODEL: process.env.VIDEO_FALLBACK_MODEL || 'google/gemini-2.5-flash',
  // Потолок размера видео для анализа, МБ. У Telegram Bot API скачивание всё
  // равно ограничено 20 МБ — держим тот же предел для всех каналов.
  VIDEO_MAX_MB: parseInt(process.env.VIDEO_MAX_MB || '20', 10),
  DAILY_VIDEO_LIMIT: parseInt(process.env.DAILY_VIDEO_LIMIT || '10', 10),

  // Контакты, которые ВСЕГДА считаются боссом (chat_id / телефон), даже если есть
  // в реестре сотрудников. Список через запятую. Босс может писать и в TG, и в WA.
  BOSS_CONTACTS: (process.env.BOSS_CONTACTS || '').split(',').map((s) => s.trim().replace(/\D/g, '')).filter(Boolean),

  // MySQL
  MYSQL_HOST: process.env.MYSQL_HOST || '',
  MYSQL_PORT: parseInt(process.env.MYSQL_PORT || '3306', 10),
  MYSQL_DATABASE: process.env.MYSQL_DATABASE || '',
  MYSQL_USER: process.env.MYSQL_USER || '',
  MYSQL_PASSWORD: process.env.MYSQL_PASSWORD || '',

  // WhatsApp (Baileys WebSocket)
  WA_AUTH_DIR: process.env.WA_AUTH_DIR || 'auth_info_baileys',
  WA_PAIRING_PHONE: process.env.WA_PAIRING_PHONE || '',  // номер для pairing code, только цифры

  // Remote pairing web page (/pair) — публичная HTTPS-страница для удалённой
  // привязки WhatsApp. PAIR_TOKEN обязателен (минимум 16 случайных символов);
  // без него /pair возвращает 503. ENABLE_TUNNEL поднимает Cloudflare Quick
  // Tunnel для гарантированного HTTPS на мобильных браузерах.
  PAIR_TOKEN,
  ENABLE_TUNNEL: process.env.ENABLE_TUNNEL === '1' || process.env.ENABLE_TUNNEL === 'true',

  // Wazzup24 (Instagram Direct + опционально WhatsApp Business). Если задан
  // WAZZUP_API_KEY, бот регистрирует webhook на /webhook/wazzup/<SECRET> при
  // каждом старте через PATCH /v3/webhooks — URL берётся из текущего активного
  // tunnel (поэтому ENABLE_TUNNEL=1 обязателен пока нет своего домена).
  // WAZZUP_WEBHOOK_SECRET защищает endpoint: путь содержит секрет, чужие POST
  // получают 404.
  WAZZUP_API_KEY: process.env.WAZZUP_API_KEY || '',
  WAZZUP_IG_CHANNEL_ID: process.env.WAZZUP_IG_CHANNEL_ID || '',
  WAZZUP_WEBHOOK_SECRET: process.env.WAZZUP_WEBHOOK_SECRET || '',
  // Опционально: ровно тот URL, который мы дадим Wazzup. Если пусто — берём
  // из tunnel. Полезно если ставим бот за свой стабильный домен.
  WAZZUP_WEBHOOK_BASE_URL: process.env.WAZZUP_WEBHOOK_BASE_URL || '',
  // Cloudflare Worker proxy URL — обходим тот факт, что Wazzup блокирует
  // *.trycloudflare.com. Если задан, бот:
  //   1) регистрирует у Wazzup webhook на ${WAZZUP_WORKER_URL}/webhook/wazzup/<SECRET>
  //   2) каждые WAZZUP_POLL_INTERVAL_MS опрашивает /poll/<SECRET> и разбирает очередь
  // Quick Tunnel при этом остаётся только для /pair-страницы.
  // Формат: https://<your-proxy>.<subdomain>.workers.dev (без слэша на конце)
  WAZZUP_WORKER_URL: process.env.WAZZUP_WORKER_URL || '',
  WAZZUP_POLL_INTERVAL_MS: parseInt(process.env.WAZZUP_POLL_INTERVAL_MS || '3000', 10),

  // Telegram
  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN || '',
  TELEGRAM_WEBHOOK_URL: process.env.TELEGRAM_WEBHOOK_URL || '',
  TELEGRAM_WEBHOOK_SECRET: process.env.TELEGRAM_WEBHOOK_SECRET || '',

  // Bot identity (shown in manager notifications)
  BOT_NAME: process.env.BOT_NAME || 'AI-бот',

  // Manager contacts — ops-оповещение при сбое ИИ (notifier.alertManager)
  MANAGER_WA: process.env.MANAGER_WA || '',           // digits only, e.g. 77771234567
  MANAGER_GROUP_WA: process.env.MANAGER_GROUP_WA || '', // WhatsApp group JID e.g. 120363...@g.us
  MANAGER_TG: process.env.MANAGER_TG || '',           // Telegram chat ID
  MANAGER_NAME: process.env.MANAGER_NAME || 'Менеджер',
  // Client-facing manager contact (free-form: phone, https://wa.me/..., @username).
  // Shown to the client on escalation so they can reach out themselves.
  MANAGER_PUBLIC_CONTACT: process.env.MANAGER_PUBLIC_CONTACT || '',
  // Отдельный технический маршрут: ошибки и ручные отзывы пользователей.
  DEVELOPER_WA: (process.env.DEVELOPER_WA || '').replace(/\D/g, ''),

  // Bot constants
  BLOCKED_PHONES: (process.env.BLOCKED_PHONES || '').split(',').map(s => s.trim()).filter(Boolean),
  EXCLUDED_CHAT_ID: process.env.EXCLUDED_CHAT_ID || '',

  // Limits
  DAILY_IMAGE_LIMIT: 10,
  DAILY_DOC_LIMIT: 10,
  DOCUMENT_CHAR_LIMIT: 20000,
  // Стэш распарсенных документов (docStash): последние N файлов на чат, TTL —
  // сколько текст живёт в памяти, чтобы manage_files action=save мог сохранить
  // файл в базу знаний без повторной пересылки текста через LLM.
  DOC_STASH_MAX: parseInt(process.env.DOC_STASH_MAX || '5', 10),
  DOC_STASH_TTL_MS: parseInt(process.env.DOC_STASH_TTL_MS || String(6 * 3600 * 1000), 10),
  // Сколько последних сообщений держим в активной истории (bot_chat_history).
  // ВСЯ переписка дополнительно архивируется в bot_message_archive (не режется),
  // и бот ищет по ней инструментом recall — так «помнит всё», а не только окно.
  CHAT_MEMORY_WINDOW: parseInt(process.env.CHAT_MEMORY_WINDOW || '1000', 10),
  // Сворачивание контекста в сводку. Срабатывает ТОЛЬКО когда сообщений стало
  // больше CONTEXT_SUMMARY_MIN_MESSAGES И их суммарный объём превысил CHAR_LIMIT
  // (не по времени — по факту переполнения). HARD_CHAR_LIMIT — аварийный потолок:
  // сжимаем раньше 1000 сообщений, лишь если объём уже грозит переполнить контекст
  // модели (защита от «залипания» на гигантских сообщениях).
  CONTEXT_SUMMARY_MIN_MESSAGES: parseInt(process.env.CONTEXT_SUMMARY_MIN_MESSAGES || '1000', 10),
  CONTEXT_SUMMARY_CHAR_LIMIT: parseInt(process.env.CONTEXT_SUMMARY_CHAR_LIMIT || '50000', 10),
  CONTEXT_SUMMARY_HARD_CHAR_LIMIT: parseInt(process.env.CONTEXT_SUMMARY_HARD_CHAR_LIMIT || '160000', 10),
  CONTEXT_KEEP_RECENT_MSGS: 20,

  // Семантический поиск по архиву (RAG). Эмбеддим чанки по EMBEDDING_CHUNK_SIZE
  // сообщений моделью EMBEDDING_MODEL через OpenRouter, усекаем вектор до
  // EMBEDDING_DIMENSIONS (Matryoshka) и нормализуем. Включается при наличии
  // OPENROUTER_API_KEY; EMBEDDING_ENABLED=0 принудительно выключает (тогда recall
  // работает по ключевым словам, как раньше).
  EMBEDDING_ENABLED: process.env.EMBEDDING_ENABLED !== '0' && process.env.EMBEDDING_ENABLED !== 'false',
  EMBEDDING_MODEL: process.env.EMBEDDING_MODEL || 'qwen/qwen3-embedding-8b',
  EMBEDDING_DIMENSIONS: parseInt(process.env.EMBEDDING_DIMENSIONS || '1024', 10),
  EMBEDDING_CHUNK_SIZE: parseInt(process.env.EMBEDDING_CHUNK_SIZE || '10', 10),
  EMBEDDING_WORKER_INTERVAL_MS: parseInt(process.env.EMBEDDING_WORKER_INTERVAL_MS || '60000', 10),
  EMBEDDING_BATCH: parseInt(process.env.EMBEDDING_BATCH || '32', 10),
  EMBEDDING_SEARCH_CANDIDATES: parseInt(process.env.EMBEDDING_SEARCH_CANDIDATES || '5000', 10),

  AI_MAX_ITERATIONS: parseInt(process.env.AI_MAX_ITERATIONS || '30', 10),
  // Прогоны по расписанию (nag/watch/interval/daily) — почти всегда 1–3 тул-раунда,
  // полные 30 итераций им не нужны. Меньший потолок режет токены на регулярных тиках.
  AI_MAX_ITERATIONS_SCHEDULED: parseInt(process.env.AI_MAX_ITERATIONS_SCHEDULED || '12', 10),
  // Потолок вызовов web_search за ОДИН прогон агента — защита от зацикливания на ненаходимом
  // (напр. курс банка). Сверх лимита поиск не выполняется, агенту возвращается «хватит искать».
  WEB_SEARCH_MAX_PER_RUN: parseInt(process.env.WEB_SEARCH_MAX_PER_RUN || '10', 10),
  // Авто-эхо вызовов инструментов в чат («Смотрю список…» перед тулом). По умолчанию
  // ВЫКЛ — раздражает в проде. Вкл: ECHO_TOOL_CALLS=1.
  ECHO_TOOL_CALLS: process.env.ECHO_TOOL_CALLS === '1' || process.env.ECHO_TOOL_CALLS === 'true',
  // Обслуживать только сотрудников и боссов (BOSS_CONTACTS), прочих игнорировать.
  // Выкл: RESTRICT_TO_KNOWN_SENDERS=0. ВНИМАНИЕ: при включённом — задайте BOSS_CONTACTS.
  RESTRICT_TO_KNOWN_SENDERS: process.env.RESTRICT_TO_KNOWN_SENDERS !== '0' && process.env.RESTRICT_TO_KNOWN_SENDERS !== 'false',
  BUFFER_TTL: 60,
  TYPING_TTL: 120,
  TYPING_INTERVAL: 4000,
  BUFFER_WAIT: 1000,

  // ── Планировщик отчётов ────────────────────────────────────────────
  // Ежедневные ритуалы компании: вечером — сбор статусов с исполнителей по их
  // открытым задачам, утром — сводка боссу (блокеры, задачи без движения).
  // Воскресенье — выходной. Выключить: REPORT_SCHEDULER=0.
  SCHEDULER_ENABLED: process.env.REPORT_SCHEDULER !== '0' && process.env.REPORT_SCHEDULER !== 'false',
  SCHEDULER_TZ_OFFSET_MIN: parseInt(process.env.SCHEDULER_TZ_OFFSET_MIN || '300', 10), // Казахстан = UTC+5
  MORNING_SUMMARY_HOUR: parseInt(process.env.MORNING_SUMMARY_HOUR || '9', 10),
  EVENING_REPORT_HOUR: parseInt(process.env.EVENING_REPORT_HOUR || '18', 10),
  // Кому слать утреннюю сводку: цифры WhatsApp через запятую. Пусто = все BOSS_CONTACTS.
  SCHEDULER_BOSS_WA: (process.env.SCHEDULER_BOSS_WA || '').split(',').map((s) => s.trim().replace(/\D/g, '')).filter(Boolean),

  // ── Планировщик действий ИИ (manage_schedule / scheduledRunner) ───────────
  // Окно catch-up для daily/weekly/monthly: если запуск протух сильнее (простой,
  // долгий агентный прогон) — помечаем missed и переносим, не шлём устаревшее.
  SCHEDULE_CATCHUP_WINDOW_MIN: parseInt(process.env.SCHEDULE_CATCHUP_WINDOW_MIN || '120', 10),
  // Защита от расходов на LLM: минимальный период interval-расписаний и потолок
  // одновременно активных расписаний (каждый запуск — полный агентный цикл).
  SCHEDULE_MIN_INTERVAL_MIN: parseInt(process.env.SCHEDULE_MIN_INTERVAL_MIN || '5', 10),
  SCHEDULE_MAX_ACTIVE: parseInt(process.env.SCHEDULE_MAX_ACTIVE || '30', 10),
  // Будильник (nag): минимальный период повторов до подтверждения, дефолт и
  // потолок числа повторов (каждый повтор — полный агентный цикл).
  SCHEDULE_NAG_MIN_INTERVAL_MIN: parseInt(process.env.SCHEDULE_NAG_MIN_INTERVAL_MIN || '5', 10),
  SCHEDULE_NAG_MAX_DEFAULT: parseInt(process.env.SCHEDULE_NAG_MAX_DEFAULT || '10', 10),
  SCHEDULE_NAG_MAX_CAP: parseInt(process.env.SCHEDULE_NAG_MAX_CAP || '20', 10),

  // ── Ассистентские фичи (референс Bot_opekyn) ──────────────────────────────
  // Веб-поиск (Brave Search API). Пусто → инструмент честно отказывает.
  BRAVE_API_KEY: process.env.BRAVE_API_KEY || '',
  // TTS (Google Gemini). Один ключ или несколько через запятую (ротация при 429).
  GOOGLE_GENAI_API_KEY: process.env.GOOGLE_GENAI_API_KEY || '',
  GOOGLE_GENAI_API_KEYS: (process.env.GOOGLE_GENAI_API_KEYS || '').split(',').map((s) => s.trim()).filter(Boolean),
  TTS_MODEL: process.env.TTS_MODEL || 'gemini-3.1-flash-tts-preview',
  TTS_VOICE: process.env.TTS_VOICE || 'Leda',
  // Голосовые ОТВЕТЫ бота (TTS). По умолчанию ВЫКЛ (босс просил только текст). Когда
  // выключено: нет авто-голоса и тулы say_voice/list_voices скрыты от LLM. Вкл: TTS_ENABLED=1.
  // На входящие голосовые (STT, распознавание) это НЕ влияет.
  TTS_ENABLED: process.env.TTS_ENABLED === '1' || process.env.TTS_ENABLED === 'true',
  // Fallback-TTS через OpenRouter (если все Google-ключи не ответили). Использует
  // OPENROUTER_API_KEY. Модель/голос можно переопределить (id зависит от каталога OpenRouter).
  OPENROUTER_TTS_MODEL: process.env.OPENROUTER_TTS_MODEL || 'google/gemini-3.1-flash-tts-preview',
  OPENROUTER_TTS_VOICE: process.env.OPENROUTER_TTS_VOICE || process.env.TTS_VOICE || 'Leda',
};

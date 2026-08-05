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

  // Безопасный режим этого развёртывания: маршруты с потенциальной оплатой
  // исключаются полностью, а не проверяются балансом на каждом запросе.
  FREE_AI_ONLY: process.env.FREE_AI_ONLY !== '0' && process.env.FREE_AI_ONLY !== 'false',

  // OpenRouter — остаётся для STT (голос) и Vision (картинки), которых нет у
  // DeepSeek, а также как fallback для текстового агента, если DeepSeek недоступен.
  OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY || '',
  // Главный мозг бота по OpenRouter: DeepSeek V4 Flash.
  OPENROUTER_MODEL: process.env.OPENROUTER_MODEL || 'deepseek/deepseek-v4-flash-0731',
  // ГЛОБАЛЬНЫЙ fallback для любых вызовов: openrouter/free — роутер, который сам
  // выбирает доступную бесплатную модель под запрос (в т.ч. с поддержкой тулов и
  // картинок). Стоит ПОСЛЕДНИМ звеном умной цепочки главного мозга и фолбэком
  // Vision/Video. Set to '' to disable.
  OPENROUTER_FALLBACK_MODEL: process.env.OPENROUTER_FALLBACK_MODEL || 'openrouter/free',
  // DeepSeek (прямой API) — первый fallback после основной модели OpenRouter.
  // Если OPENROUTER_API_KEY пуст, становится основным текстовым провайдером.
  // DeepSeek V4 Flash поддерживает tool calling.
  // STT/Vision DeepSeek НЕ умеет.
  DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY || '',
  DEEPSEEK_BASE_URL: process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com',
  DEEPSEEK_MODEL: process.env.DEEPSEEK_MODEL || 'deepseek-v4-flash',
  // AnyModel (anymodel.org) — дополнительный провайдер в умном фолбэке главного
  // мозга (после Gemini, перед openrouter/free). OpenAI-совместимый
  // эндпоинт; ключ задаётся в .env (не в git).
  ANYMODEL_API_KEY: process.env.ANYMODEL_API_KEY || '',
  ANYMODEL_BASE_URL: process.env.ANYMODEL_BASE_URL || 'https://anymodel.org/v1',
  ANYMODEL_MODEL: process.env.ANYMODEL_MODEL || 'am/glm-5.2',
  // Прямой Gemini fallback с независимой квотой на каждом ключе. Ключи
  // распределяются round-robin; исчерпавший квоту ключ временно уходит на cooldown.
  GOOGLE_GEMINI_API_KEY: process.env.GOOGLE_GEMINI_API_KEY || '',
  GOOGLE_GEMINI_API_KEYS: (process.env.GOOGLE_GEMINI_API_KEYS || '').split(',').map((s) => s.trim()).filter(Boolean),
  GOOGLE_GEMINI_BASE_URL: process.env.GOOGLE_GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta/openai/',
  GOOGLE_GEMINI_NATIVE_BASE_URL: process.env.GOOGLE_GEMINI_NATIVE_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta',
  GOOGLE_GEMINI_MODEL: process.env.GOOGLE_GEMINI_MODEL || 'gemini-3.5-flash-lite',
  GOOGLE_EMBEDDING_MODEL: process.env.GOOGLE_EMBEDDING_MODEL || 'gemini-embedding-2',
  GOOGLE_GEMINI_QUOTA_COOLDOWN_MS: Math.max(1000,
    parseInt(process.env.GOOGLE_GEMINI_QUOTA_COOLDOWN_MS || '60000', 10) || 60000),
  GOOGLE_GEMINI_TIMEOUT_MS: Math.max(1000,
    parseInt(process.env.GOOGLE_GEMINI_TIMEOUT_MS || '60000', 10) || 60000),
  // NVIDIA NIM — OpenAI-compatible free DeepSeek V4 Flash route. It is kept
  // separate from direct DeepSeek because the billing/quota owner is NVIDIA.
  NVIDIA_NIM_API_KEY: process.env.NVIDIA_NIM_API_KEY || '',
  NVIDIA_NIM_BASE_URL: process.env.NVIDIA_NIM_BASE_URL || 'https://integrate.api.nvidia.com/v1',
  NVIDIA_NIM_MODEL: process.env.NVIDIA_NIM_MODEL || 'deepseek-ai/deepseek-v4-flash',
  NVIDIA_NIM_MAX_TOKENS: Math.max(256,
    parseInt(process.env.NVIDIA_NIM_MAX_TOKENS || '16384', 10) || 16384),
  NVIDIA_NIM_REASONING_EFFORT: process.env.NVIDIA_NIM_REASONING_EFFORT || 'high',
  // Бесплатный GLM через официальный Z.AI API. В текстовой цепочке идёт сразу
  // после Gemini и до AnyModel/OpenRouter Free.
  ZAI_API_KEY: process.env.ZAI_API_KEY || '',
  ZAI_BASE_URL: process.env.ZAI_BASE_URL || 'https://api.z.ai/api/paas/v4/',
  ZAI_MODEL: process.env.ZAI_MODEL || 'glm-4.7-flash',
  ZAI_FALLBACK_MODEL: process.env.ZAI_FALLBACK_MODEL || 'glm-4.5-flash',
  // Потолок длины ответа LLM (output tokens). ВАЖНО: без явного лимита OpenRouter
  // резервирует полный лимит модели (напр. 65536) и требует баланс под него → 402
  // «requires more credits». Явный потолок снимает 402 и удешевляет ответы. 32768 —
  // большой запас на длинные планы/отчёты; всё ещё вдвое меньше 65536. Переопределяется.
  // ПРИМЕЧАНИЕ: при почти пустом балансе OpenRouter даже этот лимит может дать 402 —
  // тогда нужно пополнить баланс, а не уменьшать лимит.
  LLM_MAX_TOKENS: parseInt(process.env.LLM_MAX_TOKENS || '32768', 10),
  // Один провайдер не должен подвешивать всю цепочку. Скрытые SDK-ретраи отключены;
  // после этого таймаута circuit открывается и запрос сразу идёт следующему маршруту.
  LLM_PROVIDER_TIMEOUT_MS: Math.max(5000,
    parseInt(process.env.LLM_PROVIDER_TIMEOUT_MS || '30000', 10) || 30000),

  // STT (распознавание речи) и Vision (распознавание картинок) через OpenRouter.
  // У каждого есть primary + fallback: если primary падает после ретраев —
  // запрос обслуживает fallback-модель. STT-fallback — мультимодальный nemotron
  // (принимает голосовые через chat.completions audio_url; протестировать).
  // Vision/Video-fallback — глобальный бесплатный роутер openrouter/free.
  STT_MODEL: process.env.STT_MODEL || 'openai/whisper-large-v3-turbo',
  STT_FALLBACK_MODEL: process.env.STT_FALLBACK_MODEL || 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free',
  // Последний бесплатный резерв одновременно для STT и Vision, если Gemini
  // и openrouter/free временно недоступны.
  MEDIA_LAST_RESORT_MODEL: process.env.MEDIA_LAST_RESORT_MODEL
    || 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free',
  VISION_MODEL: process.env.VISION_MODEL || 'google/gemini-3.1-flash-lite-preview',
  VISION_FALLBACK_MODEL: process.env.VISION_FALLBACK_MODEL || 'openrouter/free',
  // Видео (обычное, кружки, гифки) смотрит Gemini через OpenRouter (content type
  // video_url, base64 data-URL — маршрутизируется в провайдера с поддержкой видео).
  // Дополнительно к описанию Gemini речь из видео транскрибируется Whisper'ом
  // (тот же STT-эндпоинт; mp4-контейнер Whisper понимает).
  VIDEO_MODEL: process.env.VIDEO_MODEL || 'google/gemini-3.1-flash-lite-preview',
  VIDEO_FALLBACK_MODEL: process.env.VIDEO_FALLBACK_MODEL || 'openrouter/free',
  // Потолок размера видео для анализа, МБ. У Telegram Bot API скачивание всё
  // равно ограничено 20 МБ — держим тот же предел для всех каналов.
  VIDEO_MAX_MB: parseInt(process.env.VIDEO_MAX_MB || '20', 10),
  DAILY_VIDEO_LIMIT: parseInt(process.env.DAILY_VIDEO_LIMIT || '10', 10),

  // Контакты, которые ВСЕГДА считаются боссом (chat_id / телефон), даже если есть
  // в реестре сотрудников. Список через запятую. Босс может писать и в TG, и в WA.
  BOSS_CONTACTS: (process.env.BOSS_CONTACTS || '').split(',').map((s) => s.trim().replace(/\D/g, '')).filter(Boolean),
  // Кто, кроме босса, может утверждать общие правила поведения. По умолчанию
  // используем технический контакт разработчика, если он задан.
  POLICY_ADMIN_CONTACTS: (process.env.POLICY_ADMIN_CONTACTS || process.env.DEVELOPER_WA || '')
    .split(',').map((s) => s.trim().replace(/\D/g, '')).filter(Boolean),

  // MySQL
  MYSQL_HOST: process.env.MYSQL_HOST || '',
  MYSQL_PORT: parseInt(process.env.MYSQL_PORT || '3306', 10),
  MYSQL_DATABASE: process.env.MYSQL_DATABASE || '',
  MYSQL_USER: process.env.MYSQL_USER || '',
  MYSQL_PASSWORD: process.env.MYSQL_PASSWORD || '',

  // WhatsApp (Baileys WebSocket)
  WA_AUTH_DIR: process.env.WA_AUTH_DIR || 'auth_info_baileys',
  WA_PAIRING_PHONE: process.env.WA_PAIRING_PHONE || '',  // номер для pairing code, только цифры
  // Группы WhatsApp, которые бот только наблюдает и архивирует. Можно указать
  // точный JID (120...@g.us) и/или название группы, через запятую.
  OBSERVE_ONLY_GROUP_WA: (process.env.OBSERVE_ONLY_GROUP_WA || '')
    .split(',').map((s) => s.trim()).filter(Boolean),
  OBSERVE_ONLY_GROUP_NAMES: (process.env.OBSERVE_ONLY_GROUP_NAMES || 'Склад отгрузки, Неодрейн Казахстан, Neodrain Kazakhstan')
    .split(',').map((s) => s.trim()).filter(Boolean),
  // Если true — бот наблюдает ВСЕ группы, в которых состоит аккаунт (read-only).
  // Отдельных настроек OBSERVE_ONLY_GROUP_* в таком случае можно не заполнять.
  OBSERVE_ALL_GROUPS: (process.env.OBSERVE_ALL_GROUPS || 'true').trim().toLowerCase() === 'true',
  // Оригиналы голосовых наблюдаемой группы сохраняются для повторной расшифровки.
  // Защита от случайно присланных очень больших файлов.
  OBSERVED_GROUP_AUDIO_MAX_BYTES: Math.max(1024 * 1024,
    parseInt(process.env.OBSERVED_GROUP_AUDIO_MAX_BYTES || String(32 * 1024 * 1024), 10) || 32 * 1024 * 1024),
  // Кто может запросить отчёт по наблюдаемой группе в личном чате.
  // Имена — запасной вариант; для строгой идентификации укажи номера.
  GROUP_REPORT_REQUESTERS_WA: (process.env.GROUP_REPORT_REQUESTERS_WA || '')
    .split(',').map((s) => s.trim().replace(/\D/g, '')).filter(Boolean),
  GROUP_REPORT_REQUESTER_NAMES: (process.env.GROUP_REPORT_REQUESTER_NAMES || 'Стас')
    .split(',').map((s) => s.trim()).filter(Boolean),

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
  // Файловая память: полный текст документа кладём в буфер (docStash) целиком до
  // DOC_KB_CHAR_LIMIT — чтобы в базу знаний влезали крупные таблицы/прайсы, а не
  // только 20k. В контекст LLM при этом отдаём лишь превью первых
  // DOC_INLINE_PREVIEW_CHARS символов (полный текст остаётся в буфере для save).
  DOC_KB_CHAR_LIMIT: parseInt(process.env.DOC_KB_CHAR_LIMIT || String(2 * 1000 * 1000), 10),
  DOC_INLINE_PREVIEW_CHARS: parseInt(process.env.DOC_INLINE_PREVIEW_CHARS || '8000', 10),
  // Логистика: вес пустого поддона (кг) — добавляется к весу товара при подборе
  // машины (в файлах «Вес одной палеты» = 25 кг).
  PALLET_TARE_KG: 25,
  // Стэш распарсенных документов (docStash): последние N файлов на чат, TTL —
  // сколько текст живёт в памяти, чтобы manage_files action=save мог сохранить
  // файл в базу знаний без повторной пересылки текста через LLM.
  DOC_STASH_MAX: parseInt(process.env.DOC_STASH_MAX || '5', 10),
  DOC_STASH_TTL_MS: parseInt(process.env.DOC_STASH_TTL_MS || String(6 * 3600 * 1000), 10),
  // Стэш ОРИГИНАЛЬНЫХ бинарников присланных .docx/.xlsx (docBinaryStash): нужен
  // для хирургической правки Word и точной арифметики по таблицам 1С. Буферы
  // тяжёлые — держим меньше файлов, чем текстовый стэш.
  DOC_BINARY_STASH_MAX: parseInt(process.env.DOC_BINARY_STASH_MAX || '3', 10),
  DOC_BINARY_STASH_TTL_MS: parseInt(process.env.DOC_BINARY_STASH_TTL_MS || String(6 * 3600 * 1000), 10),
  // Оригиналы входящих медиа нужны для повторной транскрипции/анализа и правки
  // документов после рестарта. Производные данные остаются в архиве навсегда.
  MEDIA_RETENTION_DAYS: Math.max(1, parseInt(process.env.MEDIA_RETENTION_DAYS || '90', 10) || 90),
  MEDIA_MAX_BYTES: Math.max(1024 * 1024,
    parseInt(process.env.MEDIA_MAX_BYTES || String(32 * 1024 * 1024), 10) || 32 * 1024 * 1024),
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

  // Семантический поиск по архиву (RAG). При наличии Google-ключей используем
  // бесплатный GOOGLE_EMBEDDING_MODEL; иначе — EMBEDDING_MODEL через OpenRouter.
  // Вектор усекаем до
  // EMBEDDING_DIMENSIONS (Matryoshka) и нормализуем. Включается при наличии
  // ключа выбранного провайдера; EMBEDDING_ENABLED=0 выключает (тогда recall
  // работает по ключевым словам, как раньше).
  EMBEDDING_ENABLED: process.env.EMBEDDING_ENABLED !== '0' && process.env.EMBEDDING_ENABLED !== 'false',
  EMBEDDING_MODEL: process.env.EMBEDDING_MODEL || 'nvidia/llama-nemotron-embed-vl-1b-v2:free',
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
  GOOGLE_GENAI_API_KEY: process.env.GOOGLE_GENAI_API_KEY || process.env.GOOGLE_GEMINI_API_KEY || '',
  GOOGLE_GENAI_API_KEYS: (process.env.GOOGLE_GENAI_API_KEYS || process.env.GOOGLE_GEMINI_API_KEYS || '')
    .split(',').map((s) => s.trim()).filter(Boolean),
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

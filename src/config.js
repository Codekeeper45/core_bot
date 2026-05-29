'use strict';
require('dotenv').config();

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
  PAIR_TOKEN: process.env.PAIR_TOKEN || '',
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

  // Bot identity (shown in manager notifications)
  BOT_NAME: process.env.BOT_NAME || 'AI-бот',

  // Manager contacts (for notify_manager tool)
  MANAGER_WA: process.env.MANAGER_WA || '',           // digits only, e.g. 77771234567
  MANAGER_GROUP_WA: process.env.MANAGER_GROUP_WA || '', // WhatsApp group JID e.g. 120363...@g.us
  MANAGER_TG: process.env.MANAGER_TG || '',           // Telegram chat ID
  MANAGER_NAME: process.env.MANAGER_NAME || 'Менеджер',
  // Client-facing manager contact (free-form: phone, https://wa.me/..., @username).
  // Shown to the client on escalation so they can reach out themselves.
  MANAGER_PUBLIC_CONTACT: process.env.MANAGER_PUBLIC_CONTACT || '',

  // Bot constants
  BLOCKED_PHONES: (process.env.BLOCKED_PHONES || '').split(',').map(s => s.trim()).filter(Boolean),
  EXCLUDED_CHAT_ID: process.env.EXCLUDED_CHAT_ID || '',

  // Limits
  DAILY_IMAGE_LIMIT: 10,
  DAILY_DOC_LIMIT: 10,
  DOCUMENT_CHAR_LIMIT: 20000,
  CHAT_MEMORY_WINDOW: 100,
  // Rolling context summarization: when the whole history exceeds this many
  // characters, the oldest part is compressed into a running summary and the
  // last CONTEXT_KEEP_RECENT_MSGS messages are kept verbatim.
  CONTEXT_SUMMARY_CHAR_LIMIT: 50000,
  CONTEXT_KEEP_RECENT_MSGS: 20,
  AI_MAX_ITERATIONS: 20,
  HANDOFF_TTL: 600,
  WAITING_TTL: 100,
  BUFFER_TTL: 60,
  TYPING_TTL: 120,
  TYPING_INTERVAL: 4000,
  BUFFER_WAIT: 1000,
};

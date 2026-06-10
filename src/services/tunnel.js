'use strict';
const config = require('../config');

let activeTunnel = null;
let currentUrl = null;
let restartTimer = null;

// Cloudflare Quick Tunnel — HTTPS-туннель к localhost без аккаунта и доменов.
// Нужен потому что мобильные браузеры (Chrome Mobile, HTTPS-Only Mode) и многие
// сотовые операторы блокируют HTTP / нестандартные порты. Прямой порт бота
// наружу не отдаём.
function startTunnel() {
  if (activeTunnel) return currentUrl;

  // Lazy-require: пакет `cloudflared` качает бинарник при первом импорте, нет
  // смысла грузить его если ENABLE_TUNNEL=0.
  let Tunnel;
  try {
    ({ Tunnel } = require('cloudflared'));
  } catch (err) {
    console.error('[Tunnel] Пакет cloudflared не установлен. Запустите `npm install cloudflared` или отключите ENABLE_TUNNEL.');
    return null;
  }

  const target = `http://localhost:${config.PORT}`;
  let t;
  try {
    t = Tunnel.quick(target);
  } catch (err) {
    console.error('[Tunnel] Не удалось стартовать quick tunnel:', err.message);
    scheduleRestart();
    return null;
  }
  activeTunnel = t;

  t.once('url', (url) => {
    currentUrl = url;
    const tokenSuffix = config.PAIR_TOKEN
      ? `/pair?token=${encodeURIComponent(config.PAIR_TOKEN)}`
      : '/pair (PAIR_TOKEN не задан — страница вернёт 503)';
    console.log(`[Tunnel] ✅ HTTPS: ${url}`);
    console.log(`[Tunnel] PAIR PAGE: ${url}${tokenSuffix.startsWith('/pair?') ? tokenSuffix : ''}`);
    if (!config.PAIR_TOKEN) {
      console.warn('[Tunnel] ⚠️ PAIR_TOKEN не задан — задайте его в .env, иначе /pair заблокирован.');
    }

    // Auto-register Wazzup webhook на текущий tunnel URL ТОЛЬКО если нет
    // Worker'а и нет стабильного домена. Worker (WAZZUP_WORKER_URL) и
    // стабильный домен (WAZZUP_WEBHOOK_BASE_URL) регистрируются в index.js
    // на app.listen — у них URL не меняется на рестартах. Tunnel-режим
    // оставлен для случая, когда Wazzup внезапно перестанет блокировать
    // *.trycloudflare.com (маловероятно, но код пусть будет).
    if (config.WAZZUP_API_KEY && config.WAZZUP_WEBHOOK_SECRET && !config.WAZZUP_WORKER_URL && !config.WAZZUP_WEBHOOK_BASE_URL) {
      const webhookUri = `${url.replace(/\/$/, '')}/webhook/wazzup/${encodeURIComponent(config.WAZZUP_WEBHOOK_SECRET)}`;
      registerWithRetries(webhookUri);
    } else if (config.WAZZUP_API_KEY && !config.WAZZUP_WEBHOOK_SECRET) {
      console.warn('[Wazzup] WAZZUP_WEBHOOK_SECRET не задан — webhook не зарегистрирован. Сгенерируйте: openssl rand -hex 32');
    }

    // Сообщаем Worker'у текущий tunnel URL, чтобы он мог проксировать
    // POST'ы от Wazzup напрямую к боту (без KV-задержки в 60 сек).
    // Worker внутри Cloudflare network резолвит *.trycloudflare.com мгновенно.
    if (config.WAZZUP_WORKER_URL && config.WAZZUP_WEBHOOK_SECRET) {
      registerBotUrlOnWorker(url).catch(err => console.error('[Worker] register-bot fail:', err.message));
    }
  });

  t.on('exit', (code) => {
    console.warn(`[Tunnel] exited (code=${code}), перезапуск через 10 сек`);
    activeTunnel = null;
    currentUrl = null;
    scheduleRestart();
  });

  return null; // url ещё не известен, придёт через event
}

// Регистрируем текущий tunnel URL у Worker'а с ретраями. Делаем 1-2 попытки
// — если Worker недоступен, fallback на поллинг всё равно работает.
async function registerBotUrlOnWorker(botBaseUrl) {
  const workerUrl = `${config.WAZZUP_WORKER_URL.replace(/\/$/, '')}/register-bot/${encodeURIComponent(config.WAZZUP_WEBHOOK_SECRET)}`;
  for (let attempt = 1; attempt <= 3; attempt++) {
    if (attempt > 1) await new Promise(r => setTimeout(r, 2000 * attempt));
    try {
      const res = await fetch(workerUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: botBaseUrl }),
      });
      if (res.ok) {
        console.log(`[Worker] register-bot OK: ${botBaseUrl} (attempt ${attempt})`);
        return;
      }
      const t = await res.text().catch(() => '');
      console.warn(`[Worker] register-bot HTTP ${res.status} (attempt ${attempt}): ${t.slice(0,200)}`);
    } catch (err) {
      console.warn(`[Worker] register-bot fetch err (attempt ${attempt}): ${err.message}`);
    }
  }
  console.error('[Worker] register-bot failed after 3 attempts — fallback на поллинг будет использоваться');
}

// Wazzup сразу делает test-POST {test:true} на присланный webhook URL и
// валидирует доступность. Quick-Tunnel субдомены trycloudflare.com иногда
// доходят до внешних DNS-резолверов с задержкой 5–60 секунд → первый PATCH
// падает на ENOTFOUND. Ретраим с экспоненциальным back-off.
async function registerWithRetries(webhookUri) {
  const masked = webhookUri.replace(config.WAZZUP_WEBHOOK_SECRET, '***');
  const delaysMs = [3_000, 8_000, 15_000, 25_000, 40_000];
  for (let attempt = 1; attempt <= delaysMs.length + 1; attempt++) {
    await new Promise(r => setTimeout(r, attempt === 1 ? 3_000 : delaysMs[attempt - 2]));
    try {
      await require('./wazzup').registerWebhook(webhookUri);
      console.log(`[Wazzup] Webhook зарегистрирован (попытка ${attempt}): ${masked}`);
      return;
    } catch (err) {
      const msg = err.message || '';
      const transientDns = msg.includes('ENOTFOUND') || msg.includes('getaddrinfo') || msg.includes('EAI_AGAIN') || msg.includes('testPostNotPassed') || msg.includes('WEBHOOKS_REQUEST_ERROR');
      if (!transientDns || attempt > delaysMs.length) {
        console.error(`[Wazzup] registerWebhook фейл (попытка ${attempt}, дальше не пробую):`, msg);
        return;
      }
      console.warn(`[Wazzup] registerWebhook попытка ${attempt} (DNS ещё не распространился): жду ${delaysMs[attempt - 1] / 1000}с`);
    }
  }
}

function scheduleRestart() {
  if (restartTimer) return;
  restartTimer = setTimeout(() => {
    restartTimer = null;
    startTunnel();
  }, 10_000);
}

function stopTunnel() {
  if (restartTimer) {
    clearTimeout(restartTimer);
    restartTimer = null;
  }
  if (activeTunnel) {
    try { activeTunnel.stop(); } catch (_) {}
    activeTunnel = null;
    currentUrl = null;
  }
}

function getCurrentUrl() {
  return currentUrl;
}

module.exports = { startTunnel, stopTunnel, getCurrentUrl };

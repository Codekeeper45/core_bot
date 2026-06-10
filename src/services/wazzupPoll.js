'use strict';
const config = require('../config');

// Polling-клиент для Cloudflare Worker'а (cloudflare-worker/worker.js).
// Worker буферизует POST'ы от Wazzup в KV; этот модуль забирает их.
//
// Зачем поллинг вместо прямого webhook: Wazzup блокирует *.trycloudflare.com
// (антифрод-блок-лист), а Pterodactyl-хост не даёт открытых 80/443 для своего
// домена с Let's Encrypt. Worker на *.workers.dev — стабильный публичный URL,
// который Wazzup пускает, и его легко полить из бота.

let pollTimer = null;
let inFlight = false;

async function pollOnce(processMessage) {
  if (inFlight) return;        // одна итерация за раз
  if (!config.WAZZUP_WORKER_URL || !config.WAZZUP_WEBHOOK_SECRET) return;
  inFlight = true;

  const url = `${config.WAZZUP_WORKER_URL.replace(/\/$/, '')}/poll/${encodeURIComponent(config.WAZZUP_WEBHOOK_SECRET)}`;

  try {
    const res = await fetch(url, { method: 'GET' });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.error(`[WazzupPoll] poll ${res.status}: ${body.slice(0, 200)}`);
      return;
    }
    const data = await res.json();
    const payloads = Array.isArray(data?.payloads) ? data.payloads : [];
    if (payloads.length === 0) return;

    console.log(`[WazzupPoll] получено ${payloads.length} payload'ов из Worker'а`);

    for (const p of payloads) {
      const body = p?.body;
      if (!body) continue;

      // createContact — пришёл через fallback. Wazzup уже не ждёт ответа
      // (poll был ПОЗЖЕ оригинального POST'а) — просто логируем.
      if (body.createContact) {
        const c = body.createContact;
        const cd = (Array.isArray(c.contactData) && c.contactData[0]) || {};
        console.log(`[WazzupPoll] createContact (via queue): ${cd.chatType}:${cd.chatId} name=${c.name}`);
        continue;
      }

      const messages = Array.isArray(body.messages) ? body.messages : [];
      for (const m of messages) {
        if (m.status && m.status !== 'inbound') continue;     // skip outgoing status updates
        try {
          await processMessage({ __wazzup: true, wazzupMsg: m });
        } catch (err) {
          console.error('[WazzupPoll] processMessage error:', err.message);
        }
      }
    }
  } catch (err) {
    console.error('[WazzupPoll] fetch error:', err.message);
  } finally {
    inFlight = false;
  }
}

function startPolling(processMessage) {
  if (pollTimer) return;
  if (!config.WAZZUP_WORKER_URL) {
    console.log('[WazzupPoll] WAZZUP_WORKER_URL не задан — поллинг отключён');
    return;
  }
  if (!config.WAZZUP_WEBHOOK_SECRET) {
    console.warn('[WazzupPoll] WAZZUP_WEBHOOK_SECRET не задан — поллинг не стартует');
    return;
  }
  const interval = Math.max(1000, config.WAZZUP_POLL_INTERVAL_MS || 3000);
  console.log(`[WazzupPoll] старт: ${config.WAZZUP_WORKER_URL} раз в ${interval} мс`);
  pollTimer = setInterval(() => { pollOnce(processMessage); }, interval);
  // Первый тик сразу, чтобы не ждать interval.
  setImmediate(() => pollOnce(processMessage));
}

function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

module.exports = { startPolling, stopPolling, pollOnce };

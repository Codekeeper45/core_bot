/**
 * Wazzup proxy Worker — v2 (proxy mode).
 *
 * Wazzup24 блокирует *.trycloudflare.com на своей стороне (антифрод-листы).
 * Worker сидит на стабильном *.workers.dev (не в блок-листах) и работает
 * как ОБЕ роли:
 *   1) PROXY: Wazzup POST → Worker → пересылает на текущий tunnel URL бота.
 *      DNS *.trycloudflare.com резолвится в Cloudflare network мгновенно,
 *      поэтому проксирование работает без задержек и без KV-consistency.
 *   2) QUEUE (fallback): если бот не зарегистрирован или offline, сообщения
 *      складываются в KV с TTL 1 час. Бот их забирает поллингом когда
 *      поднимется.
 *
 * Endpoints (все защищены WEBHOOK_SECRET в пути):
 *   POST /webhook/wazzup/<secret>  ← Wazzup пушит сюда
 *   POST /register-bot/<secret>    ← бот сообщает свой текущий tunnel URL
 *   GET  /poll/<secret>            ← бот забирает буфер (fallback)
 *   GET  /                         ← health
 *
 * Bindings:
 *   - WEBHOOK_SECRET (var)  shared secret
 *   - WAZZUP_QUEUE   (kv)   очередь сообщений + регистрация URL бота
 */

const BOT_URL_KEY = 'bot_url';
const QUEUE_KEY = 'queue';

// Free-tier Cloudflare KV лимиты:
//   100k reads/day, 1k writes/day, 1k list/day.
// Поллинг раз в 3 сек = 28 800 GET-вызовов/день — это нормально для reads,
// но если бы мы делали list+delete на каждое сообщение, list-лимит улетал бы
// за пару часов. Поэтому очередь хранится в ОДНОМ ключе queue (JSON-массив),
// все операции — простые get/put на этот ключ. List не используется вообще.

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const secret = env.WEBHOOK_SECRET;

    if (!secret) return text('not configured: missing WEBHOOK_SECRET', 503);
    if (!env.WAZZUP_QUEUE) return text('not configured: missing WAZZUP_QUEUE KV', 503);

    // === Бот регистрирует свой текущий tunnel URL ===
    const regMatch = path.match(/^\/register-bot\/([^/]+)\/?$/);
    if (request.method === 'POST' && regMatch) {
      if (regMatch[1] !== secret) return text('forbidden', 403);
      let body;
      try { body = await request.json(); } catch { return text('bad json', 400); }
      const botUrl = String(body?.url || '').trim();
      if (!/^https:\/\/[^/]+/.test(botUrl)) return text('invalid url', 400);
      await env.WAZZUP_QUEUE.put(BOT_URL_KEY, botUrl);
      console.log(`[register-bot] bot_url=${botUrl}`);
      return json({ ok: true, registered: botUrl });
    }

    // === Wazzup → Worker → бот ===
    const inMatch = path.match(/^\/webhook\/wazzup\/([^/]+)\/?$/);
    if (request.method === 'POST' && inMatch) {
      if (inMatch[1] !== secret) return text('forbidden', 403);

      const bodyText = await request.text();
      let parsed = null;
      try { parsed = JSON.parse(bodyText); } catch {}

      // Wazzup test ping при PATCH /v3/webhooks — отвечаем сразу без проксирования
      if (parsed && parsed.test === true) {
        console.log('[wazzup] test ping');
        return json({ ok: true, kind: 'test' });
      }

      const botUrl = await env.WAZZUP_QUEUE.get(BOT_URL_KEY);
      if (botUrl) {
        // Direct proxy. Mirror status/body from bot — Wazzup увидит реальный
        // ответ бота. Таймаут 25 сек — у Wazzup всё равно 30.
        const forward = `${botUrl.replace(/\/$/, '')}/webhook/wazzup/${encodeURIComponent(secret)}`;
        try {
          const ctl = new AbortController();
          const tm = setTimeout(() => ctl.abort(), 25_000);
          const proxied = await fetch(forward, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: bodyText,
            signal: ctl.signal,
          });
          clearTimeout(tm);
          const respText = await proxied.text();
          console.log(`[proxy] → ${proxied.status} from ${forward.replace(secret, '***')}`);
          return new Response(respText || '{"ok":true}', {
            status: proxied.status,
            headers: { 'content-type': 'application/json; charset=utf-8' },
          });
        } catch (err) {
          console.log(`[proxy] FAIL ${err.message} — fallback to queue`);
          // fallthrough → queue
        }
      } else {
        console.log('[wazzup] bot_url not registered — queueing');
      }

      // Fallback: ставим в очередь, бот заберёт поллингом.
      // Single-key queue: 1 GET + 1 PUT на сообщение, без list().
      const current = await env.WAZZUP_QUEUE.get(QUEUE_KEY, 'json') || [];
      current.push({
        ts: Date.now(),
        body: parsed || bodyText,
      });
      // Сохраняем последние 200 — защита от distress если бот долго offline.
      const trimmed = current.slice(-200);
      await env.WAZZUP_QUEUE.put(QUEUE_KEY, JSON.stringify(trimmed));
      return json({ ok: true, fallback: 'queued', count: trimmed.length });
    }

    // === Бот забирает буфер (fallback) ===
    // 1 GET, и только если буфер не пустой — 1 PUT с пустым массивом.
    // На пустых поллах НИ ОДНОЙ write-операции. Это критично для дневных лимитов.
    const pollMatch = path.match(/^\/poll\/([^/]+)\/?$/);
    if (request.method === 'GET' && pollMatch) {
      if (pollMatch[1] !== secret) return text('forbidden', 403);

      const queue = await env.WAZZUP_QUEUE.get(QUEUE_KEY, 'json') || [];
      if (queue.length === 0) {
        return json({ ok: true, count: 0, payloads: [] });
      }
      // Очищаем атомарно — но KV не даёт CAS, поэтому редкая race-condition
      // (новый POST между нашим GET и PUT) приведёт к небольшой потере. Для
      // безопасности можно delete, но put '[]' даёт более чистую семантику.
      await env.WAZZUP_QUEUE.put(QUEUE_KEY, '[]');
      const payloads = queue.map((item, i) => ({ key: `idx:${i}-ts:${item.ts}`, body: item.body }));
      return json({ ok: true, count: payloads.length, payloads });
    }

    // === Health ===
    if (path === '/' || path === '/health') {
      const botUrl = await env.WAZZUP_QUEUE.get(BOT_URL_KEY);
      return json({
        ok: true,
        worker: 'wazzup-proxy',
        bot_url: botUrl || null,
        bot_registered: !!botUrl,
        ts: Date.now(),
      });
    }

    console.log(`[unknown] ${request.method} ${path}`);
    return text('not found', 404);
  },
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}
function text(msg, status = 200) {
  return new Response(msg, { status, headers: { 'content-type': 'text/plain; charset=utf-8' } });
}

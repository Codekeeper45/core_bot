'use strict';
require('dotenv').config();
const express = require('express');
const config = require('./config');

const { normalizeInbound } = require('./channels/normalize');
const waChannel = require('./channels/whatsapp');
const tgChannel = require('./channels/telegram');
const igChannel = require('./channels/instagram');
const baileysService = require('./services/baileys');
const wazzup = require('./services/wazzup');

const { bufferAndCollect } = require('./middleware/buffer');
const { checkHandoff } = require('./middleware/handoff');
const { acquireLock, enqueue, releaseLockAndProcessQueue } = require('./middleware/concurrency');
const { checkRateLimit } = require('./middleware/rateLimit');
const { isDuplicate } = require('./middleware/deduplication');
const { setHandoff, clearHandoff, initTables } = require('./services/mysql');
const { startTypingLoop, stopTypingLoop } = require('./middleware/typing');

const { transcribeVoice } = require('./media/voice');
const { analyzeImages, checkDailyImageLimit, incrementDailyImageCount } = require('./media/image');
const { processDocument } = require('./media/document');

const { runAgent } = require('./agent/agent');

const { sanitizeReply } = require('./security/sanitizer');

const app = express();
app.use(express.json({ limit: '10mb' }));

// Remote WhatsApp pairing page (/pair, /pair/qr.png, /pair/code, /pair/status).
// Все ручки внутри роутера сами проверяют ?token=... и возвращают 503, если
// PAIR_TOKEN не задан — поэтому монтировать можно безусловно.
app.use('/pair', require('./routes/pair'));

// =====================================================================
// Wazzup24 webhook (Instagram Direct и прочие транспорты Wazzup).
// Секрет в пути защищает от случайных/чужих POST. Wazzup делает test-POST
// {test: true} при PATCH /v3/webhooks — должны вернуть 200, иначе они
// не сохранят URL.
// =====================================================================
app.post('/webhook/wazzup/:secret', async (req, res) => {
  const expected = config.WAZZUP_WEBHOOK_SECRET;
  if (!expected || req.params.secret !== expected) {
    return res.status(404).end();
  }

  const body = req.body || {};

  // Wazzup test ping при PATCH /v3/webhooks
  if (body.test === true) {
    console.log('[Wazzup] Test webhook OK');
    return res.status(200).json({ ok: true });
  }

  // createContact: Wazzup сообщает что в их системе появился новый контакт.
  // Должны ответить JSON-объектом entity, иначе Wazzup будет ретраить.
  if (body.createContact) {
    const c = body.createContact;
    const cd = (Array.isArray(c.contactData) && c.contactData[0]) || {};
    const fakeContact = {
      id: `bot-${cd.chatType || 'x'}-${cd.chatId || Date.now()}`,
      responsibleUserId: c.responsibleUserId || '1',
      name: c.name || cd.chatId || 'Unknown',
      contactData: c.contactData || [],
    };
    res.status(200).json(fakeContact);
    console.log(`[Wazzup] createContact: chatType=${cd.chatType} chatId=${cd.chatId} name=${c.name}`);
    return;
  }

  // createDeal: аналогично. У нас нет CRM сделок — просто echo.
  if (body.createDeal) {
    const d = body.createDeal;
    res.status(200).json({
      id: `bot-deal-${Date.now()}`,
      responsibleUserId: d.responsibleUserId || '1',
      contacts: d.contacts || [],
      name: 'Auto deal',
    });
    console.log(`[Wazzup] createDeal: responsibleUserId=${d.responsibleUserId} contacts=${(d.contacts||[]).join(',')}`);
    return;
  }

  // messages — основной поток
  res.status(200).json({ ok: true });

  const messages = Array.isArray(body.messages) ? body.messages : [];
  for (const m of messages) {
    // Игнор статусов исходящих (sent/delivered/read) — нам важны только inbound.
    if (m.status && m.status !== 'inbound') continue;
    try {
      await processMessage({ __wazzup: true, wazzupMsg: m });
    } catch (err) {
      console.error('[Wazzup] processMessage error:', err.message);
    }
  }
});

// =====================================================================
// Главная функция обработки сообщения
// =====================================================================
async function processMessage(rawPayload) {
  // Шаг 1: Нормализация
  const n = normalizeInbound(rawPayload);

  // Canned reply for unsupported IG types (stickers, vCard, geo, video,
  // missing_call) — отправляем заглушку и не дёргаем агента вообще.
  if (n.unsupported_canned_message && n.channel && n.chat_id) {
    try { await sendReply(n.channel, n.chat_id, n.unsupported_canned_message); } catch (_) {}
    return;
  }
  if (!n.is_supported) return;

  const { channel, chat_id, phone, client_name, message_type } = n;

  // Шаг 1.5: Команды управления (/pause, /resume)
  const rawCmd = (n.message || '').trim().toLowerCase();
  if (rawCmd === '/pause' || rawCmd === '/stop') {
    await setHandoff(channel, chat_id, { active: true, reason: 'manual_pause', started_at: new Date().toISOString() }, config.HANDOFF_TTL);
    if (channel === 'telegram' && n.message_id) {
      await tgChannel.deleteMessage(chat_id, n.message_id);
    }
    return;
  }
  if (rawCmd === '/resume') {
    await clearHandoff(channel, chat_id);
    if (channel === 'telegram' && n.message_id) {
      await tgChannel.deleteMessage(chat_id, n.message_id);
    }
    return;
  }

  // Шаг 2: Проверка дневного лимита изображений
  if (message_type === 'image') {
    const limitExceeded = await checkDailyImageLimit(channel, chat_id);
    if (limitExceeded) {
      await sendReply(channel, chat_id, 'Сегодня можно отправить не больше 10 фотографий. Попробуйте продолжить завтра.');
      return;
    }
    await incrementDailyImageCount(channel, chat_id);
  }

  // Шаг 3: Обработка голоса и документов (до буфера)
  let messageContent = n.message || '';
  let imgRef = null;
  let baileysMediaObj = null;

  if (message_type === 'voice') {
    messageContent = await transcribeVoice(n);
  } else if (message_type === 'image') {
    imgRef = n.image_source || n.image_url || '';
    baileysMediaObj = n.baileys_media_obj || null;
    messageContent = n.image_caption || '';
  } else if (message_type === 'document') {
    const docResult = await processDocument(n);
    if (docResult.error) {
      await sendReply(channel, chat_id, docResult.error);
      return;
    }
    messageContent = docResult.text;
  }

  // Шаг 4: Буферизация
  const bufferEntry = {
    timestamp: Date.now(),
    content: messageContent,
    img_url: imgRef,
    baileys_media_obj: baileysMediaObj,
  };

  // Key the buffer by channel:chat_id (like every other middleware) so two
  // channels with a colliding chat_id can't merge into one batch.
  const buffered = await bufferAndCollect(`${channel}:${chat_id}`, bufferEntry);
  if (!buffered) return;

  let { combined_message, buffered_images, has_buffered_images } = buffered;

  // Шаг 5: Проверка Handoff
  const handoffResult = await checkHandoff(channel, chat_id, combined_message);
  if (handoffResult.muted) return;
  combined_message = handoffResult.message;

  // Шаг 5.5: Rate limit check (before concurrency lock to avoid holding locks for rate-limited messages)
  const rateLimitResult = checkRateLimit(channel, chat_id);
  if (rateLimitResult.limited) {
    await sendReply(channel, chat_id, rateLimitResult.message);
    return;
  }

  // Шаг 5.6: Deduplication check (before concurrency lock to avoid holding locks for duplicates)
  if (isDuplicate(channel, chat_id, combined_message)) {
    return;
  }

  // Шаг 6: Антифлуд — Concurrency Guard
  const locked = await acquireLock(channel, chat_id);
  if (!locked) {
    await enqueue(channel, chat_id, rawPayload);
    return;
  }

  try {
    // Шаг 7: Анализ изображений
    if (has_buffered_images && buffered_images.length > 0) {
      try {
        const imageContext = await analyzeImages(buffered_images, channel, chat_id);
        combined_message = `${imageContext}\n\n${combined_message}`;
      } catch (err) {
        console.error('[Main] Image analysis error:', err.message);
      }
    }

    // Шаг 8: Typing indicator
    startTypingLoop(channel, chat_id);

    // Шаг 9: AI Agent (tool-calling loop)
    // Добавляем системный timestamp к сообщению
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const systemTimestamp = `[СИСТЕМА: дата и время сообщения (UTC) — ${now.getUTCFullYear()}-${pad(now.getUTCMonth()+1)}-${pad(now.getUTCDate())} ${pad(now.getUTCHours())}:${pad(now.getUTCMinutes())}]`;
    const combinedWithTime = `${systemTimestamp}\n${combined_message}`;

    let replyText;
    try {
      replyText = await runAgent({
        combinedMessage: combinedWithTime,
        channel,
        chatId: chat_id,
        phone,
        clientName: client_name,
      });
    } catch (err) {
      console.error('[Main] Agent error:', err.message);
      replyText = 'Произошла ошибка при обработке сообщения. Пожалуйста, повторите запрос чуть позже.';
    }

    // Шаг 10: Остановить typing, отправить ответ
    await stopTypingLoop(chat_id);
    if (replyText) {
      replyText = sanitizeReply(replyText);
      await sendReply(channel, chat_id, replyText);
    }
  } finally {
    await releaseLockAndProcessQueue(channel, chat_id, processMessage);
  }
}

// =====================================================================
// Отправка ответа по каналу
// =====================================================================
async function sendReply(channel, chatId, text) {
  try {
    if (channel === 'telegram') {
      await tgChannel.sendMessage(chatId, text);
    } else if (channel === 'instagram') {
      await igChannel.sendMessage(chatId, text);
    } else {
      await waChannel.sendMessage(chatId, text);
    }
  } catch (err) {
    console.error('[SendReply] Error:', err.message);
  }
}

// =====================================================================
// Health check with metrics
// =====================================================================
app.get('/health', async (req, res) => {
  const start = Date.now();
  const health = {
    status: 'ok',
    ts: new Date().toISOString(),
    uptime_seconds: Math.floor(process.uptime()),
    memory: {
      rss_mb: Math.round(process.memoryUsage().rss / 1024 / 1024),
      heap_used_mb: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
      heap_total_mb: Math.round(process.memoryUsage().heapTotal / 1024 / 1024),
    },
  };

  // MySQL connectivity check
  try {
    const { dbQuery } = require('./services/mysql');
    await dbQuery('SELECT 1 AS ok');
    health.mysql = 'connected';
  } catch (err) {
    health.mysql = `error: ${err.message}`;
    health.status = 'degraded';
  }

  // Agent reliability metrics (since process start). Non-zero error counters
  // mean degraded user experiences.
  try {
    const { getAgentMetrics } = require('./agent/agent');
    const m = getAgentMetrics();
    health.agent = m;
    const failures = m.llm_error + m.empty_reply + m.unexpected_error;
    health.agent_failure_rate = m.total > 0 ? Math.round((failures / m.total) * 1000) / 10 + '%' : '0%';
    if (m.total > 0 && failures / m.total > 0.1) health.status = 'degraded';
  } catch (err) {
    health.agent = `error: ${err.message}`;
  }

  health.response_time_ms = Date.now() - start;
  const statusCode = health.status === 'ok' ? 200 : 503;
  res.status(statusCode).json(health);
});

// =====================================================================
// Запуск
// =====================================================================
async function startServer() {
  // Init MySQL tables
  await initTables();

  // Telegram
  const bot = tgChannel.getBot();

  if (config.TELEGRAM_WEBHOOK_URL) {
    const webhookPath = '/webhook/telegram';
    app.post(webhookPath, (req, res) => {
      res.sendStatus(200);
      bot.handleUpdate(req.body).catch(err => console.error('[TG Webhook] Error:', err.message));
    });
    await bot.telegram.setWebhook(`${config.TELEGRAM_WEBHOOK_URL}${webhookPath}`);
    console.log(`[TG] Webhook set to ${config.TELEGRAM_WEBHOOK_URL}${webhookPath}`);
  } else {
    bot.on('message', (ctx) => {
      processMessage(ctx.update).catch(err => console.error('[TG Polling] Error:', err.message));
    });
    bot.launch().catch(err => console.error('[TG Launch] Error:', err.message));
    console.log('[TG] Long polling started');
  }

  // WhatsApp via Baileys WebSocket
  baileysService.on('message', (baileysMsg) => {
    processMessage({ __baileys: true, baileysMsg })
      .catch(err => console.error('[Baileys] Message error:', err.message));
  });
  await baileysService.connect();

  // HTTP server (health check + TG webhook if configured)
  const server = app.listen(config.PORT, () => {
    console.log(`[Server] ${config.BOT_NAME} running on port ${config.PORT}`);
    if (config.ENABLE_TUNNEL) {
      try {
        require('./services/tunnel').startTunnel();
      } catch (err) {
        console.error('[Tunnel] startup error:', err.message);
      }
    }

    // ── Wazzup webhook registration ────────────────────────────────────────
    // Приоритет источников:
    //   1) WAZZUP_WORKER_URL — Cloudflare Worker прокси (рекомендуется).
    //      Wazzup пушит туда, бот поллит /poll/<SECRET>.
    //   2) WAZZUP_WEBHOOK_BASE_URL — свой стабильный домен.
    //   3) Иначе ничего не регистрируем тут (tunnel сам это сделает в своём
    //      url-event, если ENABLE_TUNNEL=1; но trycloudflare Wazzup блокирует).
    if (config.WAZZUP_API_KEY && config.WAZZUP_WEBHOOK_SECRET) {
      let base = '';
      let mode = '';
      if (config.WAZZUP_WORKER_URL) {
        base = config.WAZZUP_WORKER_URL;
        mode = 'worker';
      } else if (config.WAZZUP_WEBHOOK_BASE_URL) {
        base = config.WAZZUP_WEBHOOK_BASE_URL;
        mode = 'stable-domain';
      }
      if (base) {
        const uri = `${base.replace(/\/$/, '')}/webhook/wazzup/${encodeURIComponent(config.WAZZUP_WEBHOOK_SECRET)}`;
        // contactsAndDealsCreation:true — на новые контакты/сделки Wazzup шлёт
        // createContact webhook. Для Instagram это срабатывает раньше чем
        // messages-webhook на сообщение в Message Requests, поэтому мы можем
        // хотя бы пингнуть менеджера «новый лид, проверь Requests в IG».
        const subs = { messagesAndStatuses: true, contactsAndDealsCreation: true };
        setTimeout(() => {
          wazzup.registerWebhook(uri, subs)
            .then(() => console.log(`[Wazzup] Webhook зарегистрирован (${mode}, subs=${Object.keys(subs).filter(k => subs[k]).join('+')}): ${base}`))
            .catch(err => console.error(`[Wazzup] registerWebhook error (${mode}):`, err.message));
        }, 1500);
      }
    }

    // Start polling loop if Worker is configured. Worker буферизует входящие
    // POST'ы от Wazzup, бот забирает их этим поллингом.
    if (config.WAZZUP_WORKER_URL && config.WAZZUP_WEBHOOK_SECRET) {
      require('./services/wazzupPoll').startPolling(processMessage);
    }
  });

  const shutdown = (signal) => {
    console.log(`[Server] Shutting down (${signal})...`);
    bot.stop(signal);
    if (config.ENABLE_TUNNEL) {
      try { require('./services/tunnel').stopTunnel(); } catch (_) {}
    }
    try { require('./services/wazzupPoll').stopPolling(); } catch (_) {}
    server.close(() => {
      console.log('[Server] HTTP server closed');
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10000);
  };
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
}

startServer().catch(err => {
  console.error('[Startup] Fatal error:', err.message);
  process.exit(1);
});

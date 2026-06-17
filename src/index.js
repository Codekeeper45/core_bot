'use strict';
require('dotenv').config();

// ─── Глушим утечку ключей в логи ─────────────────────────────────────────────
// libsignal (Signal-шифрование WhatsApp) при штатной ротации сессий печатает в
// console ЦЕЛЫЕ объекты сессий, включая ПРИВАТНЫЕ ключи («Closing session:
// SessionEntry {…}»). Это нормальное поведение протокола, но ключам в логах не
// место — фильтруем ровно эти записи (патчить node_modules бессмысленно: хостинг
// переустанавливает зависимости при каждом старте).
{
  const NOISY = [
    'Closing session', 'Opening session', 'Removing old closed session',
    'Session already closed', 'Session already open', 'Migrating session to',
  ];
  const wrap = (orig) => (...args) => {
    if (typeof args[0] === 'string' && NOISY.some((p) => args[0].startsWith(p))) return;
    orig(...args);
  };
  console.info = wrap(console.info.bind(console));
  console.warn = wrap(console.warn.bind(console));
}

const express = require('express');
const config = require('./config');

const { normalizeInbound } = require('./channels/normalize');
const waChannel = require('./channels/whatsapp');
const tgChannel = require('./channels/telegram');
const igChannel = require('./channels/instagram');
const baileysService = require('./services/baileys');
const wazzup = require('./services/wazzup');
const notifier = require('./services/notifier');
const voiceFlag = require('./services/voiceFlag');

const { bufferAndCollect } = require('./middleware/buffer');
const { acquireLock, enqueue, releaseLockAndProcessQueue } = require('./middleware/concurrency');
const { checkRateLimit } = require('./middleware/rateLimit');
const { isDuplicate } = require('./middleware/deduplication');
const { isAllowedSender } = require('./middleware/access');
const { clearHistory, initTables, setQuiet, clearQuiet, getQuiet } = require('./services/mysql');
const { startTypingLoop, stopTypingLoop } = require('./middleware/typing');

const { transcribeVoice } = require('./media/voice');
const { analyzeImages, checkDailyImageLimit, incrementDailyImageCount } = require('./media/image');
const { processDocument } = require('./media/document');

const { runAgent, _internals: agentInternals } = require('./agent/agent');

// Аварийные ответы агента (любой сбой LLM / пустой ответ / внутренняя ошибка):
// по расписанию их не доставляем (иначе босс ловит ошибку по таймеру), но в
// интерактивном чате — показываем честно. Набор всех таких сообщений — из agent.
const FALLBACK_REPLIES = agentInternals.FALLBACK_MESSAGES || new Set();
function isFallbackReply(text) {
  return FALLBACK_REPLIES.has(String(text || '').trim());
}

const { sanitizeReply } = require('./security/sanitizer');
const { isSilentStub } = require('./utils/silentStub');

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

  // Шаг 1.4: Фильтр доступа — обслуживаем только сотрудников и боссов, прочих молча игнорируем.
  // Роль (boss/employee) вычисляем ВСЕГДА — она нужна для code-level гейта инструментов
  // (а не только промпта), иначе сотрудник prompt-инъекцией дёрнет админ-инструменты.
  const access = await isAllowedSender(channel, chat_id, phone);
  if (config.RESTRICT_TO_KNOWN_SENDERS && !access.allowed) {
    console.log(`[Access] Игнор постороннего отправителя (${channel})`);
    return;
  }
  // Неизвестный при выключенном фильтре = наименьшие права (не босс).
  const senderRole = access.role || 'employee';

  // Шаг 1.5: Команды управления
  const rawCmd = (n.message || '').trim().toLowerCase();
  // Очистка истории диалога — «начать новую задачу с чистого листа».
  // Стирает контекст переписки этого чата (проекты/задачи в БД НЕ трогает).
  const RESET_CMDS = new Set(['/new', '/новый', '/reset', '/сброс', '/clear', '/очистить', '/новая']);
  if (RESET_CMDS.has(rawCmd)) {
    await clearHistory(channel, chat_id);
    await sendReply(channel, chat_id,
      'История диалога очищена. Можно ставить новую задачу с чистого листа. '
      + '(Планы и задачи сохранены.)');
    return;
  }

  // Тихий режим — «не пиши мне первым». ПРЯМЫЕ команды (без участия ИИ — работают
  // даже когда LLM недоступен). /stop [минуты] — замолчать (проактивные напоминания/
  // проверки/сводки молчат, на сообщения бот отвечает); /start — снова на связи.
  // Персонально по (channel, chat_id) — каждый глушит только себя.
  const STOP_CMDS = new Set(['/stop', '/стоп', '/quiet', '/mute', '/тихо']);
  const START_CMDS = new Set(['/start', '/старт', '/resume', '/unmute', '/продолжай']);
  const cmdWord = rawCmd.split(/\s+/)[0];
  if (STOP_CMDS.has(cmdWord)) {
    const m = parseInt(rawCmd.split(/\s+/)[1], 10);
    const digits = String(phone || '').replace(/\D/g, '') || null;
    let untilUtc = null;
    if (Number.isInteger(m) && m > 0) {
      const mins = Math.min(m, 7 * 24 * 60); // потолок — неделя
      untilUtc = new Date(Date.now() + mins * 60000).toISOString().slice(0, 19).replace('T', ' ');
    }
    try { await setQuiet(channel, chat_id, digits, untilUtc); } catch (_) {}
    await sendReply(channel, chat_id,
      (untilUtc
        ? `Тихий режим включён на ${Math.min(m, 7 * 24 * 60)} мин. `
        : 'Тихий режим включён. ')
      + 'Первым не пишу — напоминания, проверки и сводки молчат. Контроль-сторож по задачам '
      + 'продолжит эскалировать критичное (сотрудник не вышел/не сделал). На сообщения отвечаю '
      + 'как обычно. Команда /start — снять.');
    return;
  }
  if (START_CMDS.has(cmdWord)) {
    let had = false;
    try { had = await clearQuiet(channel, chat_id); } catch (_) {}
    await sendReply(channel, chat_id,
      had ? 'Тихий режим снят — снова пишу по расписанию.'
        : 'Тихий режим и так был выключен — пишу по расписанию.');
    return;
  }
  // /status — прямая команда: текущее состояние тихого режима (без участия ИИ).
  const STATUS_CMDS = new Set(['/status', '/статус']);
  if (STATUS_CMDS.has(cmdWord)) {
    let q = null;
    try { q = await getQuiet(channel, chat_id); } catch (_) {}
    const active = !!(q && Number(q.active));
    let msg;
    if (!active) msg = 'Тихий режим: ВЫКЛ — пишу по расписанию. Команды: /stop — замолчать, /stop 60 — на 60 мин.';
    else if (q.quiet_until) {
      const local = new Date(new Date(String(q.quiet_until).replace(' ', 'T') + 'Z').getTime() + config.SCHEDULER_TZ_OFFSET_MIN * 60000)
        .toISOString().slice(0, 16).replace('T', ' ');
      msg = `Тихий режим: ВКЛ до ${local}. Первым не пишу. /start — снять сейчас.`;
    } else msg = 'Тихий режим: ВКЛ (бессрочно). Первым не пишу. /start — снять.';
    await sendReply(channel, chat_id, msg);
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
  // Дескриптор входящего медиа для пересылки (forward_message): ссылки/идентификаторы,
  // по которым медиа можно ПОВТОРНО скачать в момент пересылки (см. media/incomingMedia.js).
  let mediaDescriptor = null;

  if (message_type === 'voice') {
    messageContent = await transcribeVoice(n);
    mediaDescriptor = {
      type: 'voice', channel,
      file_id: n.voice_file_id || null,
      source_url: n.voice_source_url || null,
      baileys_media_obj: n.baileys_media_obj || null,
      file_name: 'voice.ogg', mime: n.voice_mime_type || null,
    };
  } else if (message_type === 'image') {
    imgRef = n.image_source || n.image_url || '';
    baileysMediaObj = n.baileys_media_obj || null;
    messageContent = n.image_caption || '';
    mediaDescriptor = {
      type: 'image', channel, ref: imgRef,
      baileys_media_obj: baileysMediaObj,
      file_name: 'photo.jpg', mime: 'image/jpeg',
    };
  } else if (message_type === 'document') {
    const docResult = await processDocument(n);
    if (docResult.error) {
      await sendReply(channel, chat_id, docResult.error);
      return;
    }
    messageContent = docResult.text;
    mediaDescriptor = {
      type: 'document', channel,
      file_id: n.document_file_id || null,
      source_url: n.document_source_url || null,
      baileys_media_obj: n.baileys_media_obj || null,
      file_name: n.document_file_name || 'файл', mime: n.document_mime_type || null,
    };
  }

  // Шаг 4: Буферизация
  const bufferEntry = {
    timestamp: Date.now(),
    content: messageContent,
    img_url: imgRef,
    baileys_media_obj: baileysMediaObj,
    media: mediaDescriptor,
  };

  // Key the buffer by channel:chat_id (like every other middleware) so two
  // channels with a colliding chat_id can't merge into one batch.
  const buffered = await bufferAndCollect(`${channel}:${chat_id}`, bufferEntry);
  if (!buffered) return;

  let { combined_message, buffered_images, has_buffered_images } = buffered;
  const buffered_media = buffered.buffered_media || [];

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
    const combinedWithTime = `${systemTimestamp()}\n${combined_message}`;

    let replyText;
    voiceFlag.reset(channel, chat_id); // агент мог сам озвучить через say_voice — отметит флаг
    try {
      replyText = await runAgent({
        combinedMessage: combinedWithTime,
        channel,
        chatId: chat_id,
        phone,
        clientName: client_name,
        role: senderRole,
        media: buffered_media, // входящие вложения текущего батча — для forward_message

        // Авто-эхо: бот шлёт в чат короткие строки о вызываемых тулах в реальном времени.
        emit: (text) => sendReply(channel, chat_id, text),
      });
    } catch (err) {
      console.error('[Main] Agent error:', err.message);
      // Честно: называем причину по сути ошибки (баланс/модель/сеть), а не «повторите позже».
      replyText = agentInternals.classifyLlmError(err.message);
    }

    // Шаг 10: Остановить typing, отправить ответ
    await stopTypingLoop(chat_id);
    if (replyText) {
      replyText = sanitizeReply(replyText);
    }
    if (replyText && replyText.trim()) {
      await sendReply(channel, chat_id, replyText);
      // Авто-голос (safety net): если босс написал ГОЛОСОМ, а агент НЕ озвучил сам через
      // say_voice — озвучиваем текст ответа (без тегов). Instagram голос не поддерживает.
      if (config.TTS_ENABLED && message_type === 'voice' && channel !== 'instagram'
          && !voiceFlag.taken(channel, chat_id)) {
        try {
          const { synthesizeSpeech } = require('./services/tts');
          const r = await synthesizeSpeech(replyText);
          if (r.ok) await notifier.deliver(channel, chat_id, '', r.media);
        } catch (err) {
          console.error('[TTS] auto-voice:', err.message);
        }
      }
    }
  } finally {
    await releaseLockAndProcessQueue(channel, chat_id, processMessage);
  }
}

// Системный штамп «сейчас» (локальное время компании + UTC) — общий хелпер,
// используется и в processMessage, и в deliverInstruction (планировщик).
const { systemTimestamp } = require('./utils/localTime');

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

// Выполнить инструкцию ботом от имени владельца (для scheduledRunner): захватить лок чата,
// прогнать обычный агентный цикл (role=boss), ответ отправить владельцу. Единый с processMessage
// путь ответа в канал. Возвращает {ok, reason?, reply?}.
async function deliverInstruction({ channel, chatId, phone, clientName, instruction, silentToOwner }) {
  const locked = await acquireLock(channel, chatId);
  if (!locked) return { ok: false, reason: 'lock_busy' }; // босс сейчас пишет — повторим на след. tick

  try {
    // Роль владельца расписания вычисляем по факту (босс vs сотрудник): личное
    // расписание сотрудника должно исполняться под ЕГО ролью, без боссовых тулов.
    // Неизвестный отправитель (например удалён из реестра) → employee, без эскалации.
    const access = await isAllowedSender(channel, chatId, phone);
    const role = access.role || 'employee';
    const combinedMessage = `${systemTimestamp()}\n${instruction}`;
    let reply;
    try {
      reply = await runAgent({
        combinedMessage,
        channel,
        chatId,
        phone,
        clientName: clientName || (role === 'boss' ? 'boss' : ''),
        role,
        // Прогон по расписанию — короче интерактивного: отдельный меньший потолок итераций.
        maxIterations: config.AI_MAX_ITERATIONS_SCHEDULED,
        emit: (text) => sendReply(channel, chatId, text),
      });
    } catch (err) {
      console.error('[Deliver] Agent error:', err.message);
      return { ok: false, reason: 'agent_error' };
    }
    // ИИ сам решает, есть ли что сообщить (промпт). Пустой ответ — молчим. Заглушки
    // (FALLBACK_* при кратком сбое LLM) по расписанию НЕ шлём — иначе босс получает
    // «Наши системы загружены» по таймеру. Считаем это мягким сбоем → ретрай.
    if (reply && isFallbackReply(reply)) {
      return { ok: false, reason: 'agent_error' };
    }
    // silentToOwner — прогон адресован НЕ боссу (сторож пишет сотруднику): боссу не шлём.
    // isSilentStub — модель проговорила «пустой ответ / напоминание отправлено / проверено»
    // вместо настоящей пустоты: это шум по таймеру, не отправляем (агент-цикл уже отработал).
    if (reply && !silentToOwner && !isSilentStub(reply)) {
      const clean = sanitizeReply(reply);
      if (clean) await sendReply(channel, chatId, clean);
    }
    return { ok: true, reply };
  } finally {
    await releaseLockAndProcessQueue(channel, chatId, processMessage);
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

  // Активные расписания действий (manage_schedule).
  try {
    const { countSchedules } = require('./services/mysql');
    health.schedules = { enabled: await countSchedules() };
  } catch (err) {
    health.schedules = `error: ${err.message}`;
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

  // Предупреждение: фильтр доступа включён, но боссы не заданы → босс не сможет писать.
  if (config.RESTRICT_TO_KNOWN_SENDERS && !config.BOSS_CONTACTS.length) {
    console.warn('[Access] RESTRICT_TO_KNOWN_SENDERS включён, но BOSS_CONTACTS пуст — '
      + 'босс (если он не в реестре сотрудников) НЕ сможет писать боту. Задайте BOSS_CONTACTS в .env.');
  }

  // Telegram
  const bot = tgChannel.getBot();

  if (config.TELEGRAM_WEBHOOK_URL) {
    const webhookPath = '/webhook/telegram';
    // secret_token: Telegram присылает его в заголовке X-Telegram-Bot-Api-Secret-Token.
    // Без проверки любой может POST'ом подделать апдейт от босса и обойти фильтр доступа.
    const tgSecret = config.TELEGRAM_WEBHOOK_SECRET || require('crypto').randomBytes(24).toString('hex');
    app.post(webhookPath, (req, res) => {
      if (req.get('X-Telegram-Bot-Api-Secret-Token') !== tgSecret) {
        return res.sendStatus(403);
      }
      res.sendStatus(200);
      bot.handleUpdate(req.body).catch(err => console.error('[TG Webhook] Error:', err.message));
    });
    await bot.telegram.setWebhook(`${config.TELEGRAM_WEBHOOK_URL}${webhookPath}`, { secret_token: tgSecret });
    console.log(`[TG] Webhook set to ${config.TELEGRAM_WEBHOOK_URL}${webhookPath} (secret enabled)`);
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

  // Планировщик отчётов: вечерний сбор статусов с исполнителей, утренняя сводка боссу.
  require('./services/reportScheduler').start();

  // Планировщик произвольных действий ИИ (manage_schedule). deliverInstruction
  // инъектируем, чтобы не создавать цикл require index↔scheduledRunner.
  require('./services/scheduledRunner').start({ deliver: deliverInstruction });

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

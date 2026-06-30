'use strict';

const crypto = require('crypto');
const config = require('../config');

function redactSecrets(value) {
  return String(value == null ? '' : value)
    .replace(/\b([A-Z0-9_]*(?:API_KEY|TOKEN|PASSWORD|SECRET))\s*[:=]\s*[^\s,;]+/gi, '$1=[REDACTED]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}/g, '[REDACTED]')
    .replace(/\bpassword\s*[:=]\s*[^\s,;]+/gi, 'password=[REDACTED]');
}

function messageText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((x) => (x && x.text) || '').join(' ');
  return '';
}

function buildSafeTranscript(messages, limit = 10) {
  return (Array.isArray(messages) ? messages : [])
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && messageText(m.content).trim())
    .slice(-Math.max(1, limit))
    .map((m) => `${m.role === 'user' ? 'Пользователь' : 'Бот'}: ${redactSecrets(messageText(m.content)).slice(0, 1500)}`)
    .join('\n');
}

function fingerprint(kind, message) {
  const normalized = `${kind}:${String(message || '').replace(/\d+/g, '#').slice(0, 500)}`;
  return crypto.createHash('sha256').update(normalized).digest('hex');
}

async function submitDeveloperEvent({ kind = 'error', severity = 'error', message, channel, chatId, actorName, includeHistory = true }) {
  const mysql = require('./mysql');
  let transcript = '';
  if (includeHistory && channel && chatId) {
    try {
      const history = await mysql.loadHistory(channel, chatId);
      transcript = buildSafeTranscript(history.messages, 10);
    } catch (_) {}
  }
  const safeMessage = redactSecrets(message).slice(0, 4000);
  const event = await mysql.createOpsEvent({
    kind,
    severity,
    fingerprint: fingerprint(kind, safeMessage),
    sourceChannel: channel || null,
    sourceChatId: chatId || null,
    actorName: actorName || null,
    message: safeMessage,
    context: transcript,
    deduplicate: kind !== 'feedback',
  });
  if (!event || event.deduplicated) return { success: true, deduplicated: true, event_id: event && event.id };
  const delivered = await deliverEvent(event);
  return { success: delivered, event_id: event.id, queued: !delivered };
}

async function deliverEvent(event) {
  if (!config.DEVELOPER_WA) return false;
  const notifier = require('./notifier');
  const parts = [
    `[BOT ${String(event.severity || 'info').toUpperCase()}] ${event.kind || 'event'} #${event.id}`,
    event.actor_name ? `Автор: ${event.actor_name}` : '',
    event.source_channel ? `Канал: ${event.source_channel}` : '',
    event.message,
    event.context_text ? `Последние сообщения:\n${event.context_text}` : '',
  ].filter(Boolean);
  const ok = await notifier.deliver('whatsapp', config.DEVELOPER_WA, parts.join('\n'));
  const mysql = require('./mysql');
  if (ok) await mysql.markOpsEventDelivered(event.id);
  else await mysql.markOpsEventAttempt(event.id);
  return ok;
}

async function processPending() {
  try {
    const mysql = require('./mysql');
    const events = await mysql.listPendingOpsEvents(20);
    for (const event of events) await deliverEvent(event);
  } catch (err) {
    console.error('[DeveloperFeedback] retry:', redactSecrets(err.message));
  }
}

let timer = null;
function start() {
  if (timer) return;
  timer = setInterval(processPending, 60_000);
  if (timer.unref) timer.unref();
  processPending().catch(() => {});
}

module.exports = {
  redactSecrets, buildSafeTranscript, submitDeveloperEvent, processPending, start,
  reportDeveloperError: (message, context = {}) => submitDeveloperEvent({ ...context, kind: 'error', severity: 'error', message }),
};


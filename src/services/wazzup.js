'use strict';
const config = require('../config');

const API_BASE = 'https://api.wazzup24.com/v3';

function authHeaders(extra) {
  if (!config.WAZZUP_API_KEY) {
    throw new Error('WAZZUP_API_KEY is not configured');
  }
  return {
    Authorization: `Bearer ${config.WAZZUP_API_KEY}`,
    Accept: 'application/json',
    ...(extra || {}),
  };
}

async function wazzupFetch(path, init = {}) {
  const res = await fetch(`${API_BASE}${path}`, init);
  const text = await res.text();
  let body;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  if (!res.ok) {
    const detail = typeof body === 'string' ? body : JSON.stringify(body);
    const err = new Error(`Wazzup ${init.method || 'GET'} ${path} → ${res.status}: ${detail}`);
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body;
}

// POST /v3/message — send a text or media message into a channel.
// IG имеет лимит 1000 символов в одном сообщении; в text не должно быть
// одновременно contentUri. Контент-URI должен быть публичным HTTPS.
async function sendMessage({ channelId, chatType, chatId, text, contentUri, refMessageId, crmMessageId }) {
  if (!channelId) throw new Error('wazzup.sendMessage: channelId required');
  if (!chatType) throw new Error('wazzup.sendMessage: chatType required');
  if (!chatId) throw new Error('wazzup.sendMessage: chatId required');
  if (!text && !contentUri) throw new Error('wazzup.sendMessage: text or contentUri required');
  if (text && contentUri) throw new Error('wazzup.sendMessage: cannot send text and contentUri together');

  const body = { channelId, chatType, chatId };
  if (text) body.text = text;
  if (contentUri) body.contentUri = contentUri;
  if (refMessageId) body.refMessageId = refMessageId;
  if (crmMessageId) body.crmMessageId = crmMessageId;

  return wazzupFetch('/message', {
    method: 'POST',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(body),
  });
}

// Download a media file given its contentUri (from incoming webhook). Wazzup
// hosts media on their CDN — usually no auth needed, но прикладываем Bearer на
// случай если URL ведёт через защищённый proxy.
async function downloadContent(contentUri) {
  if (!contentUri) throw new Error('wazzup.downloadContent: contentUri required');
  let res = await fetch(contentUri);
  if (res.status === 401 || res.status === 403) {
    res = await fetch(contentUri, { headers: authHeaders() });
  }
  if (!res.ok) {
    throw new Error(`Wazzup downloadContent failed: ${res.status} ${contentUri}`);
  }
  const buffer = Buffer.from(await res.arrayBuffer());
  const mimeType = res.headers.get('content-type') || 'application/octet-stream';
  return { buffer, mimeType };
}

// PATCH /v3/webhooks — register our public webhook URL with Wazzup.
// Wazzup делает test POST {test: true} на этот URL и ждёт 200 — наш роут
// должен это уметь, иначе Wazzup отдаст 400 testPostNotPassed и не сохранит.
async function registerWebhook(webhooksUri, subscriptions = { messagesAndStatuses: true }) {
  if (!webhooksUri) throw new Error('wazzup.registerWebhook: webhooksUri required');
  return wazzupFetch('/webhooks', {
    method: 'PATCH',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ webhooksUri, subscriptions }),
  });
}

// GET /v3/webhooks — see what's currently registered (debug helper).
async function getWebhook() {
  return wazzupFetch('/webhooks', { method: 'GET', headers: authHeaders() });
}

// GET /v3/channels — list channels (debug + IG channelId discovery).
async function listChannels() {
  return wazzupFetch('/channels', { method: 'GET', headers: authHeaders() });
}

// Авто-определение channelId для Instagram. channelId пересоздаётся при каждом
// переподключении канала в Wazzup, поэтому хардкод в .env протухает. Здесь —
// источник правды: берём актуальный активный IG-канал из самого Wazzup и кэшируем.
// WAZZUP_IG_CHANNEL_ID из .env используется как override (если совпадает с реальным)
// и как fallback, если API недоступен. Это делает передачу клиенту простой:
// достаточно вставить его WAZZUP_API_KEY — канал бот найдёт сам.
let _igChannelCache = { id: null, ts: 0 };
const IG_CHANNEL_TTL_MS = 10 * 60 * 1000; // 10 минут

async function resolveInstagramChannelId({ force = false } = {}) {
  const envId = config.WAZZUP_IG_CHANNEL_ID || '';
  const now = Date.now();
  if (!force && _igChannelCache.id && (now - _igChannelCache.ts) < IG_CHANNEL_TTL_MS) {
    return _igChannelCache.id;
  }
  try {
    const channels = await listChannels();
    const igs = (Array.isArray(channels) ? channels : []).filter(
      c => String(c.transport).toLowerCase() === 'instagram'
    );
    if (igs.length === 0) {
      if (envId) { _igChannelCache = { id: envId, ts: now }; return envId; }
      throw new Error('в аккаунте Wazzup нет Instagram-канала');
    }
    // Предпочитаем активные; среди них уважаем явный override из .env, если он там есть.
    const active = igs.filter(c => String(c.state).toLowerCase() === 'active');
    const pool = active.length ? active : igs;
    const chosen = pool.find(c => c.channelId === envId) || pool[0];
    if (envId && chosen.channelId !== envId) {
      console.warn(`[Wazzup] WAZZUP_IG_CHANNEL_ID=${envId} не найден среди активных IG-каналов — использую актуальный ${chosen.channelId} (${chosen.plainId || chosen.name || ''})`);
    } else if (!envId) {
      console.log(`[Wazzup] IG channelId определён автоматически: ${chosen.channelId} (${chosen.plainId || chosen.name || ''})`);
    }
    _igChannelCache = { id: chosen.channelId, ts: now };
    return chosen.channelId;
  } catch (err) {
    if (envId) {
      console.error(`[Wazzup] resolveInstagramChannelId: ${err.message} — fallback на WAZZUP_IG_CHANNEL_ID из .env`);
      return envId;
    }
    throw err;
  }
}

function invalidateInstagramChannelCache() {
  _igChannelCache = { id: null, ts: 0 };
}

module.exports = { sendMessage, downloadContent, registerWebhook, getWebhook, listChannels, resolveInstagramChannelId, invalidateInstagramChannelCache };

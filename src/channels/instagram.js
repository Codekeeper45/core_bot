'use strict';
const wazzup = require('../services/wazzup');
const config = require('../config');

// Instagram Direct (via Wazzup24): chatType='instagram', chatId = IG username
// without @. Текстовый лимит у IG — 1000 символов на одно сообщение, поэтому
// длинный ответ режем на куски по границам предложений.

const IG_TEXT_LIMIT = 1000;

function splitForInstagram(text) {
  const s = String(text || '').trim();
  if (!s) return [];
  if (s.length <= IG_TEXT_LIMIT) return [s];

  const chunks = [];
  let rest = s;
  while (rest.length > IG_TEXT_LIMIT) {
    // Берём первый кусок ≤ лимита и режем по последней границе предложения,
    // абзаца или пробелу — чтобы не рвать слова.
    let cut = rest.lastIndexOf('\n\n', IG_TEXT_LIMIT);
    if (cut < IG_TEXT_LIMIT * 0.5) cut = rest.lastIndexOf('. ', IG_TEXT_LIMIT);
    if (cut < IG_TEXT_LIMIT * 0.5) cut = rest.lastIndexOf('\n', IG_TEXT_LIMIT);
    if (cut < IG_TEXT_LIMIT * 0.5) cut = rest.lastIndexOf(' ', IG_TEXT_LIMIT);
    if (cut <= 0) cut = IG_TEXT_LIMIT;
    chunks.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) chunks.push(rest);
  return chunks;
}

// Wazzup отдаёт 404 с кодом CHANNEL_NOT_FOUND, когда channelId устарел
// (канал пересоздан при переподключении). Определяем это, чтобы переопределить
// канал и повторить отправку.
function isChannelNotFound(err) {
  if (!err) return false;
  if (err.message && err.message.includes('CHANNEL_NOT_FOUND')) return true;
  const data = err.body && err.body.data;
  return Array.isArray(data) && data.some(d => d && d.code === 'CHANNEL_NOT_FOUND');
}

async function sendMessage(chatId, text) {
  const parts = splitForInstagram(text);
  if (parts.length === 0) return false;

  // channelId не из .env, а из самого Wazzup (актуальный активный IG-канал).
  let channelId;
  try {
    channelId = await wazzup.resolveInstagramChannelId();
  } catch (err) {
    console.error('[IG] не удалось определить channelId (нет активного IG-канала в Wazzup?):', err.message);
    return false;
  }

  for (const part of parts) {
    try {
      await wazzup.sendMessage({ channelId, chatType: 'instagram', chatId, text: part });
    } catch (err) {
      // Самоисцеление: канал мог пересоздаться — обновляем channelId и повторяем один раз.
      if (isChannelNotFound(err)) {
        console.warn('[IG] CHANNEL_NOT_FOUND — channelId устарел, переопределяю и повторяю');
        wazzup.invalidateInstagramChannelCache();
        try {
          channelId = await wazzup.resolveInstagramChannelId({ force: true });
          await wazzup.sendMessage({ channelId, chatType: 'instagram', chatId, text: part });
          continue;
        } catch (err2) {
          console.error('[IG] sendMessage error после переопределения канала:', err2.message);
          return false;
        }
      }
      console.error('[IG] sendMessage error:', err.message);
      return false;
    }
  }
  return true;
}

// Typing indicator: Wazzup public API does not expose a presence/typing
// endpoint for IG (только для WABA через шаблоны). Возвращаем no-op, чтобы
// общий typing-loop в middleware/typing.js не падал.
async function sendTyping(_chatId) {
  return false;
}

module.exports = { sendMessage, sendTyping, splitForInstagram };

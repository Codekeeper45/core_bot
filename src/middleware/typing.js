'use strict';
const waClient = require('../channels/whatsapp');
const tgClient = require('../channels/telegram');
const config = require('../config');

// In-memory typing loops — no Redis needed
const timers = new Map();
const active = new Set();

function startTypingLoop(channel, chatId) {
  const key = `${chatId}`;
  active.add(key);

  const loop = async () => {
    if (!active.has(key)) {
      timers.delete(key);
      return;
    }
    try {
      if (channel === 'telegram') {
        await tgClient.sendChatAction(chatId, 'typing');
      } else {
        await waClient.sendTyping(chatId);
      }
    } catch { /* ignore */ }

    if (!active.has(key)) {
      timers.delete(key);
      return;
    }
    const timer = setTimeout(loop, config.TYPING_INTERVAL);
    timers.set(key, timer);
  };

  loop();
}

async function stopTypingLoop(chatId) {
  const key = `${chatId}`;
  active.delete(key);
  const timer = timers.get(key);
  if (timer) {
    clearTimeout(timer);
    timers.delete(key);
  }
}

module.exports = { startTypingLoop, stopTypingLoop };

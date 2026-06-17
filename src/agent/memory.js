'use strict';
const { loadHistory, saveHistory } = require('../services/mysql');

// Returns { summary, messages }.
async function loadChatHistory(channel, chatId) {
  return loadHistory(channel, chatId);
}

async function saveChatHistory(channel, chatId, messages, summary = '') {
  return saveHistory(channel, chatId, messages, summary);
}

// Записать ИСХОДЯЩЕЕ сообщение бота (диспатч задачи, оповещение, пересылку) в историю
// получателя, чтобы при его следующем сообщении бот «помнил», что сам ему отправлял.
// Кладём как обычный assistant-ход под тем же ключом (channel, chatId), под которым
// лежит входящая переписка этого получателя. Load-modify-save; гонка с активным ходом
// самого получателя крайне маловероятна (исходящее обычно идёт, когда он не пишет).
async function recordOutbound(channel, chatId, text) {
  if (!channel || !chatId || !text) return;
  try {
    const { summary, messages } = await loadHistory(channel, chatId);
    messages.push({ role: 'assistant', content: String(text) });
    await saveHistory(channel, chatId, messages, summary);
  } catch (err) {
    console.error('[Memory] recordOutbound:', err.message);
  }
}

module.exports = { loadChatHistory, saveChatHistory, recordOutbound };

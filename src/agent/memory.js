'use strict';
const { loadHistory, saveHistory } = require('../services/mysql');

// Returns { summary, messages }.
async function loadChatHistory(channel, chatId) {
  return loadHistory(channel, chatId);
}

async function saveChatHistory(channel, chatId, messages, summary = '') {
  return saveHistory(channel, chatId, messages, summary);
}

module.exports = { loadChatHistory, saveChatHistory };

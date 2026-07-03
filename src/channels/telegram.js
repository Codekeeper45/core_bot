'use strict';
const { Telegraf } = require('telegraf');
const config = require('../config');

let bot;

function getBot() {
  if (!bot) {
    bot = new Telegraf(config.TELEGRAM_BOT_TOKEN);
  }
  return bot;
}

// Telegram rejects messages longer than 4096 chars (HTTP 400). Split long replies
// on sentence/paragraph/word boundaries so nothing is dropped. 4000 leaves headroom.
const TG_TEXT_LIMIT = 4000;

function splitForTelegram(text) {
  const s = String(text || '');
  if (s.length <= TG_TEXT_LIMIT) return s ? [s] : [];
  const chunks = [];
  let rest = s;
  while (rest.length > TG_TEXT_LIMIT) {
    let cut = rest.lastIndexOf('\n\n', TG_TEXT_LIMIT);
    if (cut < TG_TEXT_LIMIT * 0.5) cut = rest.lastIndexOf('. ', TG_TEXT_LIMIT);
    if (cut < TG_TEXT_LIMIT * 0.5) cut = rest.lastIndexOf('\n', TG_TEXT_LIMIT);
    if (cut < TG_TEXT_LIMIT * 0.5) cut = rest.lastIndexOf(' ', TG_TEXT_LIMIT);
    if (cut <= 0) cut = TG_TEXT_LIMIT;
    chunks.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) chunks.push(rest);
  return chunks;
}

async function sendMessage(chatId, text) {
  const parts = splitForTelegram(text);
  if (parts.length === 0) return false;
  try {
    for (const part of parts) {
      await getBot().telegram.sendMessage(chatId, part);
    }
    return true;
  } catch (err) {
    console.error('[TG] sendMessage error:', err.message);
    return false;
  }
}

// Отправить картинку (буфер PNG/JPG) с подписью.
async function sendPhoto(chatId, buffer, caption = '') {
  try {
    await getBot().telegram.sendPhoto(chatId, { source: buffer }, caption ? { caption } : {});
    return true;
  } catch (err) {
    console.error('[TG] sendPhoto error:', err.message);
    return false;
  }
}

// Отправить голосовое сообщение (ogg/opus буфер).
async function sendVoice(chatId, buffer, caption = '') {
  try {
    await getBot().telegram.sendVoice(chatId, { source: buffer }, caption ? { caption } : {});
    return true;
  } catch (err) {
    console.error('[TG] sendVoice error:', err.message);
    return false;
  }
}

// Отправить документ/файл-вложение (буфер) с именем файла.
async function sendDocument(chatId, buffer, fileName = 'файл') {
  try {
    await getBot().telegram.sendDocument(chatId, { source: buffer, filename: fileName });
    return true;
  } catch (err) {
    console.error('[TG] sendDocument error:', err.message);
    return false;
  }
}

// Отправить видео (mp4-буфер) с подписью.
async function sendVideo(chatId, buffer, caption = '') {
  try {
    await getBot().telegram.sendVideo(chatId, { source: buffer }, caption ? { caption } : {});
    return true;
  } catch (err) {
    console.error('[TG] sendVideo error:', err.message);
    return false;
  }
}

// Отправить видеокружок (круглое видео). Подписей у кружков не бывает.
async function sendVideoNote(chatId, buffer) {
  try {
    await getBot().telegram.sendVideoNote(chatId, { source: buffer });
    return true;
  } catch (err) {
    console.error('[TG] sendVideoNote error:', err.message);
    return false;
  }
}

// Отправить гифку/анимацию (mp4/gif-буфер).
async function sendAnimation(chatId, buffer, caption = '') {
  try {
    await getBot().telegram.sendAnimation(chatId, { source: buffer }, caption ? { caption } : {});
    return true;
  } catch (err) {
    console.error('[TG] sendAnimation error:', err.message);
    return false;
  }
}

// Отправить стикер (webp/webm-буфер).
async function sendSticker(chatId, buffer) {
  try {
    await getBot().telegram.sendSticker(chatId, { source: buffer });
    return true;
  } catch (err) {
    console.error('[TG] sendSticker error:', err.message);
    return false;
  }
}

async function sendChatAction(chatId, action = 'typing') {
  try {
    await getBot().telegram.sendChatAction(chatId, action);
    return true;
  } catch { return false; }
}

// Скачивает файл Telegram, возвращает { buffer, mimeType }
async function downloadFile(fileId) {
  const fileInfo = await getBot().telegram.getFile(fileId);
  const filePath = fileInfo.file_path;
  const url = `https://api.telegram.org/file/bot${config.TELEGRAM_BOT_TOKEN}/${filePath}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`TG file download failed: ${res.status}`);
  const buffer = Buffer.from(await res.arrayBuffer());
  return { buffer, url };
}

// Получить публичный URL файла Telegram
async function getFileUrl(fileId) {
  const fileInfo = await getBot().telegram.getFile(fileId);
  return `https://api.telegram.org/file/bot${config.TELEGRAM_BOT_TOKEN}/${fileInfo.file_path}`;
}

async function deleteMessage(chatId, messageId) {
  try { await getBot().telegram.deleteMessage(chatId, messageId); } catch {}
}

module.exports = {
  getBot, sendMessage, sendPhoto, sendVoice, sendDocument,
  sendVideo, sendVideoNote, sendAnimation, sendSticker,
  splitForTelegram, sendChatAction, downloadFile, getFileUrl, deleteMessage,
};

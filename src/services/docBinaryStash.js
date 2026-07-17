'use strict';
// In-memory стэш ОРИГИНАЛЬНЫХ бинарников недавно присланных Office-файлов
// (.docx / .xlsx). Текстовый пайплайн media/document.js извлекает из файла текст
// и выбрасывает бинарник — но для (а) хирургической правки .docx без потери
// форматирования и (б) точной арифметики по таблицам 1С нужен именно исходный
// байтовый файл. Этот стэш его удерживает.
//
// Зеркалит docStash.js по семантике: ключ — чат (channel:chatId), в чате храним
// последние DOC_BINARY_STASH_MAX файлов, записи старше TTL вычищаются лениво.
// Переживает только процесс: после рестарта бота файл нужно прислать заново.
// Буферы тяжёлые — поэтому cap меньше, чем у текстового стэша.
const config = require('../config');

const stash = new Map(); // `${channel}:${chatId}` → [{ fileName, buffer, mimetype, ts }] (новые в конце)

function key(channel, chatId) { return `${channel}:${String(chatId)}`; }

function prune(list, now = Date.now()) {
  const ttl = config.DOC_BINARY_STASH_TTL_MS;
  return list.filter((e) => now - e.ts <= ttl);
}

function put(channel, chatId, { fileName, buffer, mimetype = null }) {
  if (!fileName || !buffer || !Buffer.isBuffer(buffer)) return;
  const k = key(channel, chatId);
  let list = prune(stash.get(k) || []);
  // Повторная отправка того же файла заменяет запись (не плодим дубли).
  list = list.filter((e) => e.fileName.toLowerCase() !== String(fileName).toLowerCase());
  list.push({ fileName: String(fileName), buffer, mimetype: mimetype ? String(mimetype) : null, ts: Date.now() });
  while (list.length > config.DOC_BINARY_STASH_MAX) list.shift();
  stash.set(k, list);
}

// fileNameOrLast: 'last' / пусто → самый свежий; иначе регистронезависимое
// точное совпадение имени. null — нет в стэше (истёк TTL или рестарт).
function get(channel, chatId, fileNameOrLast) {
  const k = key(channel, chatId);
  const list = prune(stash.get(k) || []);
  stash.set(k, list);
  if (!list.length) return null;
  const wanted = String(fileNameOrLast || 'last').trim();
  if (!wanted || wanted.toLowerCase() === 'last') return list[list.length - 1];
  return list.find((e) => e.fileName.toLowerCase() === wanted.toLowerCase()) || null;
}

function list(channel, chatId) {
  const k = key(channel, chatId);
  const entries = prune(stash.get(k) || []);
  stash.set(k, entries);
  return entries.map((e) => ({ fileName: e.fileName, ts: e.ts, bytes: e.buffer.length, mimetype: e.mimetype }));
}

function _clear() { stash.clear(); }

module.exports = { put, get, list, _clear };

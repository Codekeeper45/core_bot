'use strict';
// In-memory стэш недавно распарсенных документов (текст уже извлечён пайплайном
// media/document.js). Нужен, чтобы инструмент manage_files action=save мог взять
// текст файла БЕЗ повторной пересылки 20k символов через аргументы LLM.
// Ключ — чат (channel:chatId), в чате храним последние DOC_STASH_MAX файлов,
// записи старше DOC_STASH_TTL_MS вычищаются лениво. Переживает только процесс:
// после рестарта бота файл нужно прислать заново (save честно вернёт not_in_stash).
const config = require('../config');

const stash = new Map(); // `${channel}:${chatId}` → [{ fileName, text, ts }] (новые в конце)

function key(channel, chatId) { return `${channel}:${String(chatId)}`; }

function prune(list, now = Date.now()) {
  const ttl = config.DOC_STASH_TTL_MS;
  return list.filter((e) => now - e.ts <= ttl);
}

function put(channel, chatId, { fileName, text }) {
  if (!fileName || !text) return;
  const k = key(channel, chatId);
  let list = prune(stash.get(k) || []);
  // Повторная отправка того же файла заменяет запись (не плодим дубли).
  list = list.filter((e) => e.fileName.toLowerCase() !== String(fileName).toLowerCase());
  list.push({ fileName: String(fileName), text: String(text), ts: Date.now() });
  while (list.length > config.DOC_STASH_MAX) list.shift();
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
  return entries.map((e) => ({ fileName: e.fileName, ts: e.ts, chars: e.text.length }));
}

function _clear() { stash.clear(); }

module.exports = { put, get, list, _clear };

'use strict';
// Рендер чанка архива в текст для эмбеддинга и показа. Каждая строка несёт ДАТУ,
// ВРЕМЯ и АВТОРА — чтобы поиск и ответ бота были привязаны ко времени и бот не
// путался в датах. Чистый модуль (без БД) — легко тестируется.
const { localStamp } = require('./localTime');

function authorOf(m) {
  if (m.actor_name && String(m.actor_name).trim()) return String(m.actor_name).trim();
  return m.role === 'user' ? 'Пользователь' : 'Бот';
}

// messages: [{ role, actor_name, content, created_at }] (по возрастанию времени).
function renderChunk(messages) {
  return (Array.isArray(messages) ? messages : [])
    .map((m) => ({ m, text: String(m.content == null ? '' : m.content).replace(/\s+/g, ' ').trim() }))
    .filter((x) => x.text)
    .map((x) => `[${localStamp(x.m.created_at)}] ${authorOf(x.m)}: ${x.text}`)
    .join('\n');
}

// Уникальные авторы чанка одной строкой (для колонки authors).
function chunkAuthors(messages) {
  const seen = [];
  for (const m of (Array.isArray(messages) ? messages : [])) {
    const a = authorOf(m);
    if (!seen.includes(a)) seen.push(a);
  }
  return seen.join(', ').slice(0, 255);
}

module.exports = { renderChunk, chunkAuthors, authorOf };

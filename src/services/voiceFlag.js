'use strict';
// Пометка «в этом ходе агент уже озвучил ответ сам (say_voice)» — чтобы авто-голос
// в index.js не дублировал голосовое. Ключ — channel:chatId, живёт в пределах одного хода
// (concurrency-lock гарантирует один ход на чат). reset() перед runAgent, mark() в say_voice,
// taken() после runAgent.
const flags = new Set();
const key = (channel, chatId) => `${channel}:${chatId}`;

module.exports = {
  reset(channel, chatId) { flags.delete(key(channel, chatId)); },
  mark(channel, chatId) { flags.add(key(channel, chatId)); },
  taken(channel, chatId) { return flags.has(key(channel, chatId)); },
};

'use strict';
// Семантический поиск по архиву: эмбеддим запрос → грузим чанки-кандидаты →
// ранжируем косинусом (векторы нормированы → косинус = скалярное произведение).
const config = require('../config');
const embeddings = require('./embeddings');
const mysql = require('./mysql');

// { ok, results:[{score, content, first_at, last_at, authors, channel, chat_id}], scanned, truncated }
// viewer = {channel, chatId, isBoss} — при scope=all не-боссу скрываются чужие private-чаты.
async function semanticRecall({ channel, chatId, query, scope = 'chat', limit = 8, viewer = null, fromUtc = null, toUtc = null } = {}) {
  if (!embeddings.isEnabled()) return { ok: false, reason: 'disabled', results: [] };
  const q = String(query || '').trim();
  if (!q) return { ok: false, reason: 'empty_query', results: [] };

  const qVec = await embeddings.embedOne(q);
  if (!qVec.length) return { ok: false, reason: 'embed_failed', results: [] };

  const rows = await mysql.loadChunkVectors({
    channel, chatId, scope, viewer,
    fromUtc, toUtc,
    model: config.EMBEDDING_MODEL,
    dims: config.EMBEDDING_DIMENSIONS,
    limit: config.EMBEDDING_SEARCH_CANDIDATES,
  });
  const truncated = rows.length >= config.EMBEDDING_SEARCH_CANDIDATES;
  if (truncated) {
    console.warn(`[MemorySearch] кандидатов ${rows.length} = потолок ${config.EMBEDDING_SEARCH_CANDIDATES}; старые чанки могли не попасть в ранжирование`);
  }

  const scored = [];
  for (const r of rows) {
    const vec = embeddings.unpackFloat32(r.embedding);
    if (vec.length !== qVec.length) continue;
    scored.push({
      score: embeddings.dot(qVec, vec),
      content: r.content,
      first_at: r.first_at,
      last_at: r.last_at,
      authors: r.authors,
      channel: r.channel,
      chat_id: r.chat_id,
      msg_count: r.msg_count,
    });
  }
  scored.sort((a, b) => b.score - a.score);
  const cap = Math.max(1, Math.min(Number(limit) || 8, 25));
  return { ok: true, scanned: rows.length, truncated, results: scored.slice(0, cap) };
}

module.exports = { semanticRecall };

'use strict';
// Фоновый воркер семантического индекса: нарезает архив на чанки по
// EMBEDDING_CHUNK_SIZE подряд идущих сообщений (на чат), эмбеддит и пишет в
// bot_archive_chunks. Тем же кодом идёт первичный бэкафилл (scripts/backfillEmbeddings).
// Эмбеддим только ПОЛНЫЕ чанки; «хвост» (<size) ждёт, пока наберётся (его пока
// покрывает рабочее окно и LIKE-поиск). Ошибки — лог + ретрай на следующем тике.
const config = require('../config');
const embeddings = require('./embeddings');
const { renderChunk, chunkAuthors } = require('../utils/chunkText');

function groupsOf(arr, size) {
  const out = [];
  for (let i = 0; i + size <= arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// Обработать один чат: добрать бэклог чанками, пока остаётся ≥ size новых сообщений.
async function processChat(mysql, channel, chatId, watermark) {
  const size = config.EMBEDDING_CHUNK_SIZE;
  const fetchLimit = size * Math.max(1, config.EMBEDDING_BATCH);
  let cursor = Number(watermark) || 0;
  let made = 0;
  for (let guard = 0; guard < 1000; guard++) {
    const msgs = await mysql.archiveMessagesAfter(channel, chatId, cursor, fetchLimit);
    if (msgs.length < size) break;
    const groups = groupsOf(msgs, size);
    const texts = groups.map(renderChunk);
    let vectors;
    try {
      vectors = await embeddings.embed(texts); // батч одним запросом
    } catch (err) {
      console.warn(`[Embeddings] retry batch with shorter text for ${channel}:${chatId}:`, err.message);
      try {
        const shortTexts = texts.map((t) => String(t || '').slice(0, 1500));
        vectors = await embeddings.embed(shortTexts);
      } catch (err2) {
        console.error(`[Embeddings] batch failed for ${channel}:${chatId}:`, err2.message);
        throw err2;
      }
    }
    for (let i = 0; i < groups.length; i++) {
      const g = groups[i];
      const vec = vectors[i] || [];
      if (!vec.length) throw new Error('пустой эмбеддинг чанка');
      await mysql.insertArchiveChunk({
        channel, chat_id: chatId,
        start_archive_id: g[0].id,
        end_archive_id: g[g.length - 1].id,
        msg_count: g.length,
        first_at: g[0].created_at,
        last_at: g[g.length - 1].created_at,
        authors: chunkAuthors(g),
        content: renderChunk(g).slice(0, 60000),
        embedding: embeddings.packFloat32(vec),
        dims: vec.length,
        model: embeddings.modelId(),
      });
      made++;
      cursor = g[g.length - 1].id;
    }
    if (msgs.length < fetchLimit) break; // добрали всё, что было
  }
  return made;
}

// Один проход по всем чатам с бэклогом. Возвращает { chats, chunks }.
async function processOnce() {
  if (!embeddings.isEnabled()) return { skipped: true, reason: 'disabled' };
  const mysql = require('./mysql');
  const size = config.EMBEDDING_CHUNK_SIZE;
  let chats = 0;
  let chunks = 0;
  const backlog = await mysql.listChatsWithBacklog(size, 200, embeddings.modelId());
  for (const c of backlog) {
    try {
      const made = await processChat(mysql, c.channel, c.chat_id, c.watermark);
      if (made) { chats++; chunks += made; }
    } catch (err) {
      console.error(`[Embeddings] чат ${c.channel}:${c.chat_id}:`, err.message);
      // watermark не двигаем — повторим на следующем тике.
    }
  }
  if (chunks) console.log(`[Embeddings] проиндексировано чанков: ${chunks} (чатов: ${chats})`);
  return { chats, chunks };
}

let timer = null;
let running = false;
function start() {
  if (timer || !embeddings.isEnabled()) {
    if (!embeddings.isEnabled()) console.log('[Embeddings] семантический индекс выключен (нет OPENROUTER_API_KEY или EMBEDDING_ENABLED=0)');
    return;
  }
  const tick = async () => {
    if (running) return;
    running = true;
    try { await processOnce(); }
    catch (err) { console.error('[Embeddings] tick:', err.message); }
    finally { running = false; }
  };
  timer = setInterval(tick, config.EMBEDDING_WORKER_INTERVAL_MS);
  if (timer.unref) timer.unref();
  tick().catch(() => {});
}

module.exports = { start, processOnce, processChat, groupsOf };

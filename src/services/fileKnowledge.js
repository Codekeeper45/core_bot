'use strict';
// База знаний по файлам: нарезка текста на чанки (параметры выбирает ИИ и передаёт
// в инструмент), эмбеддинг чанков (та же инфраструктура, что у архива переписки)
// и семантический поиск с указанием файла-источника. При выключенных эмбеддингах
// чанки хранятся без векторов, поиск падает на дословный LIKE.
const config = require('../config');
const embeddings = require('./embeddings');
const mysql = require('./mysql');

// Границы нарезки: защищают и от слишком мелких чанков (шум в выдаче), и от
// слишком крупных (не влезут в контекст ответа инструмента).
const CHUNK_MIN = 500;
const CHUNK_MAX = 4000;
const OVERLAP_MAX = 600;

function clampChunkParams({ chunkSize = 1500, overlap = 150, split = 'paragraph' } = {}) {
  const size = Math.max(CHUNK_MIN, Math.min(Number(chunkSize) || 1500, CHUNK_MAX));
  const over = Math.max(0, Math.min(Number(overlap) || 0, Math.min(OVERLAP_MAX, Math.floor(size / 3))));
  const mode = ['paragraph', 'heading', 'fixed'].includes(split) ? split : 'paragraph';
  return { chunkSize: size, overlap: over, split: mode };
}

function fixedSplit(text, chunkSize, overlap) {
  const out = [];
  const step = Math.max(1, chunkSize - overlap);
  for (let i = 0; i < text.length; i += step) {
    const piece = text.slice(i, i + chunkSize).trim();
    if (piece) out.push(piece);
    if (i + chunkSize >= text.length) break;
  }
  return out;
}

// Жадно пакуем блоки в чанки до chunkSize; негабаритный блок дорезаем fixed'ом.
// overlap — хвост предыдущего чанка в начале следующего (сохраняет контекст).
function packBlocks(blocks, chunkSize, overlap) {
  const out = [];
  let current = '';
  const flush = () => { if (current.trim()) out.push(current.trim()); current = ''; };
  for (const block of blocks) {
    if (block.length > chunkSize) {
      flush();
      out.push(...fixedSplit(block, chunkSize, overlap));
      continue;
    }
    if (current && current.length + block.length + 2 > chunkSize) flush();
    current = current ? `${current}\n\n${block}` : block;
  }
  flush();
  if (overlap > 0) {
    for (let i = 1; i < out.length; i++) {
      const tail = out[i - 1].slice(-overlap);
      out[i] = `…${tail}\n${out[i]}`;
    }
  }
  return out;
}

// Заголовкоподобные строки: [Лист: …] (xlsx), markdown #, нумерованные разделы.
const HEADING_RE = /^(\[Лист: .+\]|#{1,6}\s+.+|\d{1,2}[.)]\s+[А-ЯA-Z].+)$/;

function headingBlocks(text) {
  const lines = text.split('\n');
  const blocks = [];
  let current = [];
  for (const line of lines) {
    if (HEADING_RE.test(line.trim()) && current.length) {
      blocks.push(current.join('\n'));
      current = [line];
    } else {
      current.push(line);
    }
  }
  if (current.length) blocks.push(current.join('\n'));
  return blocks.map((b) => b.trim()).filter(Boolean);
}

function chunkText(text, params = {}) {
  const src = String(text || '').trim();
  if (!src) return [];
  const { chunkSize, overlap, split } = clampChunkParams(params);
  if (split === 'fixed') return fixedSplit(src, chunkSize, overlap);
  const blocks = split === 'heading'
    ? headingBlocks(src)
    : src.split(/\n{2,}/).map((b) => b.trim()).filter(Boolean);
  if (!blocks.length) return fixedSplit(src, chunkSize, overlap);
  return packBlocks(blocks, chunkSize, overlap);
}

// Сохранить файл: нарезать, заэмбеддить (если доступно) и записать в БД.
// Тот же владелец + то же имя = замена (файл переимпортируется целиком).
async function saveFile({ channel, chatId, ownerName, fileName, text, chunkSize, overlap, split, visibility, description } = {}) {
  const name = String(fileName || '').trim();
  if (!name) return { ok: false, reason: 'file_name_required' };
  const chunks = chunkText(text, { chunkSize, overlap, split });
  if (!chunks.length) return { ok: false, reason: 'empty_text' };

  let vectors = null;
  let embedded = false;
  if (embeddings.isEnabled()) {
    try {
      vectors = [];
      for (let i = 0; i < chunks.length; i += config.EMBEDDING_BATCH) {
        const batch = await embeddings.embed(chunks.slice(i, i + config.EMBEDDING_BATCH));
        vectors.push(...batch);
      }
      embedded = vectors.length === chunks.length && vectors.every((v) => v && v.length);
      if (!embedded) vectors = null;
    } catch (err) {
      console.error('[FileKnowledge] embed failed, сохраняю без векторов:', err.message);
      vectors = null;
    }
  }

  const rows = chunks.map((content, i) => ({
    seq: i + 1,
    content,
    embedding: vectors ? embeddings.packFloat32(vectors[i]) : null,
    dims: vectors ? config.EMBEDDING_DIMENSIONS : null,
    model: vectors ? embeddings.modelId() : null,
  }));

  const saved = await mysql.replaceFile({
    channel, chatId, ownerName,
    fileName: name,
    visibility: visibility === 'private' ? 'private' : 'public',
    description: description || null,
    charCount: String(text || '').length,
    chunks: rows,
  });
  return {
    ok: true,
    file_id: saved.id,
    file_name: name,
    replaced: saved.replaced,
    chunk_count: chunks.length,
    char_count: String(text || '').length,
    visibility: visibility === 'private' ? 'private' : 'public',
    embedded,
  };
}

// Семантический поиск по чанкам файлов (фильтр видимости — в SQL).
// Fallback на LIKE: эмбеддинги выключены/упали ИЛИ семантика ничего не нашла
// (в отличие от recall база файлов маленькая — LIKE дёшев и ловит чанки без векторов).
async function searchFiles({ channel, chatId, role, query, fileName = null, limit = 6 } = {}) {
  const q = String(query || '').trim();
  if (!q) return { ok: false, reason: 'empty_query', results: [] };
  const cap = Math.max(1, Math.min(Number(limit) || 6, 15));
  const viewer = { channel, chatId, isBoss: role === 'boss' };

  if (embeddings.isEnabled()) {
    try {
      const qVec = await embeddings.embedOne(q);
      if (qVec.length) {
        const rows = await mysql.loadFileChunkVectors({
          viewer,
          model: embeddings.modelId(),
          dims: config.EMBEDDING_DIMENSIONS,
          fileName,
          limit: config.EMBEDDING_SEARCH_CANDIDATES,
        });
        const scored = [];
        for (const r of rows) {
          const vec = embeddings.unpackFloat32(r.embedding);
          if (vec.length !== qVec.length) continue;
          scored.push({
            score: embeddings.dot(qVec, vec),
            file_id: r.file_id,
            file_name: r.file_name,
            owner_name: r.owner_name,
            visibility: r.visibility,
            seq: r.seq,
            content: r.content,
          });
        }
        scored.sort((a, b) => b.score - a.score);
        if (scored.length) return { ok: true, mode: 'semantic', results: scored.slice(0, cap) };
      }
    } catch (err) {
      console.error('[FileKnowledge] semantic search failed, LIKE fallback:', err.message);
    }
  }

  const rows = await mysql.fileKeywordSearch({ viewer, query: q, fileName, limit: cap });
  return {
    ok: true,
    mode: 'keyword',
    results: rows.map((r) => ({
      score: null, file_id: r.file_id, file_name: r.file_name, owner_name: r.owner_name,
      visibility: r.visibility, seq: r.seq, content: r.content,
    })),
  };
}

module.exports = { chunkText, clampChunkParams, saveFile, searchFiles };

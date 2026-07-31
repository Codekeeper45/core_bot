'use strict';
// Эмбеддинги для семантического поиска по архиву (RAG).
// Модель — qwen/qwen3-embedding-8b через OpenRouter (OpenAI-совместимый эндпойнт
// /embeddings). Вектор усекаем до config.EMBEDDING_DIMENSIONS (Matryoshka) и
// L2-нормализуем НА НАШЕЙ СТОРОНЕ — так не зависим от того, уважает ли провайдер
// параметр dimensions, и косинус сводится к скалярному произведению.
const config = require('../config');

// Усечь вектор до n измерений и L2-нормализовать. Пустой/битый вход → [].
function truncateNormalize(vec, n) {
  if (!Array.isArray(vec) || !vec.length) return [];
  const dims = n && n > 0 ? Math.min(n, vec.length) : vec.length;
  const out = new Array(dims);
  let sumSq = 0;
  for (let i = 0; i < dims; i++) {
    const v = Number(vec[i]) || 0;
    out[i] = v;
    sumSq += v * v;
  }
  const norm = Math.sqrt(sumSq);
  if (norm > 0) for (let i = 0; i < dims; i++) out[i] /= norm;
  return out;
}

// Float32 little-endian упаковка/распаковка для хранения в BLOB.
function packFloat32(vec) {
  const arr = Float32Array.from(vec || []);
  return Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength);
}
function unpackFloat32(buf) {
  if (!buf || !buf.length) return [];
  // Копируем в выровненный буфер (срез из БД может быть не выровнен под Float32).
  const copy = Buffer.from(buf);
  const f = new Float32Array(copy.buffer, copy.byteOffset, Math.floor(copy.length / 4));
  return Array.from(f);
}

// Косинус для НЕнормированных векторов (для нормированных = просто dot).
function cosine(a, b) {
  if (!a || !b || !a.length || a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}
function dot(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

function isEnabled() {
  return Boolean(config.EMBEDDING_ENABLED && config.OPENROUTER_API_KEY);
}

// Получить эмбеддинги для массива строк. Возвращает массив нормированных векторов
// (длины EMBEDDING_DIMENSIONS) в том же порядке. Бросает при сбое — вызывающий решает.
async function embed(texts) {
  const input = (Array.isArray(texts) ? texts : [texts]).map((t) => String(t == null ? '' : t).slice(0, 3500));
  if (!isEnabled()) throw new Error('embeddings_disabled');
  if (!input.length) return [];
  const res = await fetch('https://openrouter.ai/api/v1/embeddings', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.OPENROUTER_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ model: config.EMBEDDING_MODEL, input }),
    signal: AbortSignal.timeout(60000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`embeddings ${res.status}: ${body.slice(0, 300)}`);
  }
  const json = await res.json();
  const data = Array.isArray(json && json.data) ? json.data : [];
  if (data.length !== input.length) throw new Error(`embeddings: ожидали ${input.length}, получили ${data.length}`);
  // Сохраняем исходный порядок (на всякий — сортируем по index, если он есть).
  data.sort((a, b) => (a.index || 0) - (b.index || 0));
  return data.map((d) => truncateNormalize(d.embedding, config.EMBEDDING_DIMENSIONS));
}

async function embedOne(text) {
  const [v] = await embed([text]);
  return v || [];
}

module.exports = {
  truncateNormalize, packFloat32, unpackFloat32, cosine, dot,
  isEnabled, embed, embedOne,
};

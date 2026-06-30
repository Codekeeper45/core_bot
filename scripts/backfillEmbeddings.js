'use strict';
// Разовый полный бэкафилл семантического индекса архива. Идемпотентно: повторный
// запуск доиндексирует только новые чанки (watermark по bot_archive_chunks).
// Запуск: node scripts/backfillEmbeddings.js
require('dotenv').config();
const { initTables, getPool } = require('../src/services/mysql');
const embeddings = require('../src/services/embeddings');
const worker = require('../src/services/embeddingWorker');

async function main() {
  if (!embeddings.isEnabled()) {
    throw new Error('Эмбеддинги выключены: нет OPENROUTER_API_KEY или EMBEDDING_ENABLED=0');
  }
  await initTables();
  let total = 0;
  // Воркер за один проход добирает по чату весь бэклог; гоняем, пока не перестанет
  // появляться новое (на случай, если чатов больше, чем лимит выборки за проход).
  for (let pass = 0; pass < 50; pass++) {
    const r = await worker.processOnce();
    total += r.chunks || 0;
    console.log(`[Backfill] проход ${pass + 1}: чанков +${r.chunks || 0} (чатов ${r.chats || 0})`);
    if (!r.chunks) break;
  }
  console.log(`[Backfill] готово. Всего проиндексировано чанков: ${total}`);
}

main()
  .catch((err) => { console.error('[Backfill] Ошибка:', err.message); process.exitCode = 1; })
  .finally(async () => { try { await getPool().end(); } catch (_) {} });

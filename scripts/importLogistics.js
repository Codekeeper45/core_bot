'use strict';
// Импорт логистической/паллетировочной базы в БД: node scripts/importLogistics.js
// Грузит ВСЕ три файла из корня репозитория (Вес паллет пластик + Распаллетка + Паллетировка)
// полным рефрешем — чистит orch_logistics_items/orch_trucks и заливает заново.
// Это отдельная справочная база, к прайсам не привязана.

require('dotenv').config();
const path = require('path');
const { initTables, getPool, importLogistics } = require('../src/services/mysql');
const { parseAllLogistics } = require('../src/services/logistics');

async function main() {
  const root = path.join(__dirname, '..');
  const { items, trucks, files } = parseAllLogistics(root);
  if (!items.length && !trucks.length) {
    throw new Error('Логистические файлы не найдены в корне репозитория');
  }
  console.log(`[Logistics] Файлы: ${files.join(', ')}`);
  const bySource = items.reduce((acc, it) => { acc[it.source] = (acc[it.source] || 0) + 1; return acc; }, {});
  console.log('[Logistics] По источникам:', JSON.stringify(bySource));

  await initTables();
  const result = await importLogistics(items, trucks);
  console.log(`[Logistics] Импортировано: ${result.items_count} позиций, ${result.trucks_count} машин`);
}

main()
  .catch((err) => { console.error('[Logistics] Ошибка импорта:', err.message); process.exitCode = 1; })
  .finally(async () => {
    try { await getPool().end(); } catch (_) {}
  });

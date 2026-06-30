'use strict';

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { initTables, getPool } = require('../src/services/mysql');
const { importPriceWorkbook } = require('../src/services/priceCatalog');

async function main() {
  const root = path.join(__dirname, '..');
  const args = process.argv.slice(2);
  const force = args.includes('--force');
  const explicit = args.find((a) => !a.startsWith('--'));
  const file = explicit
    ? path.resolve(explicit)
    : fs.readdirSync(root).find((name) => /аквасток.*январь.*2026.*продажн.*\.xlsx$/iu.test(name.normalize('NFC')));
  if (!file) throw new Error('Прайс XLSX не найден в корне репозитория');
  const fullPath = path.isAbsolute(file) ? file : path.join(root, file);
  await initTables();
  const result = await importPriceWorkbook(fullPath, { force });
  const what = result.imported ? 'Импортировано' : (result.activated ? 'Реактивирован снимок' : 'Уже импортировано');
  console.log(`[Price] ${what}${force ? ' (force)' : ''}: ${result.row_count} позиций, import_id=${result.import_id}`);
}

main()
  .catch((err) => { console.error('[Price] Ошибка импорта:', err.message); process.exitCode = 1; })
  .finally(async () => {
    try { await getPool().end(); } catch (_) {}
  });

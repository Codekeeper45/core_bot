'use strict';
// Импорт прайсов в БД: node scripts/importPrice.js [файл.xlsx] [--force] [--supplier=aquastok|gidrolica]
// Без файла импортирует ОБА известных прайса из корня репо (Аквасток + Gidrolica).
// Поставщик определяется по листу файла (detectSupplier), --supplier переопределяет.

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { initTables, getPool } = require('../src/services/mysql');
const { importPriceWorkbook } = require('../src/services/priceCatalog');

const KNOWN_FILES = [
  /аквасток.*январь.*2026.*продажн.*\.xlsx$/iu,
  /гидро.*июль.*2025.*розница.*\.xlsx$/iu,
];

async function main() {
  const root = path.join(__dirname, '..');
  const args = process.argv.slice(2);
  const force = args.includes('--force');
  const supplierFlag = (args.find((a) => a.startsWith('--supplier=')) || '').split('=')[1] || null;
  const explicit = args.find((a) => !a.startsWith('--'));

  let files;
  if (explicit) {
    files = [path.resolve(explicit)];
  } else {
    // Имена файлов могут быть в NFD (macOS/копирование) — сравниваем в NFC.
    files = fs.readdirSync(root)
      .filter((name) => KNOWN_FILES.some((re) => re.test(name.normalize('NFC'))))
      .map((name) => path.join(root, name));
  }
  if (!files.length) throw new Error('Прайс XLSX не найден в корне репозитория');

  await initTables();
  for (const fullPath of files) {
    const result = await importPriceWorkbook(fullPath, { force, supplier: supplierFlag });
    const what = result.imported ? 'Импортировано' : (result.activated ? 'Реактивирован снимок' : 'Уже импортировано');
    console.log(`[Price] ${result.supplier}: ${what}${force ? ' (force)' : ''} — ${result.row_count} позиций, import_id=${result.import_id}`);
  }
}

main()
  .catch((err) => { console.error('[Price] Ошибка импорта:', err.message); process.exitCode = 1; })
  .finally(async () => {
    try { await getPool().end(); } catch (_) {}
  });

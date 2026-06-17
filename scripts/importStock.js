'use strict';
// Разовый импорт остатков из xlsx-ведомости в таблицу orch_stock.
// Использование: node scripts/importStock.js "Нижний склад 16.xlsx" Нижний
// Колонки по умолчанию: наименование = A (0), остаток = «Остаток на складе» (28).
// Идемпотентно: upsert по (location, norm_key). Подключается к той же MySQL, что и бот.

const XLSX = require('xlsx');

// Чистая функция (тестируемая): из «сырых» строк листа достаёт [{name, qty}],
// пропуская пустые имена и нечисловые остатки. Первые headerRows строк — шапка.
function parseStockRows(rows, { nameCol = 0, qtyCol = 28, headerRows = 2 } = {}) {
  const out = [];
  for (let i = headerRows; i < rows.length; i++) {
    const r = rows[i] || [];
    const name = String(r[nameCol] == null ? '' : r[nameCol]).trim();
    if (!name) continue;
    const raw = r[qtyCol];
    if (raw === '' || raw == null) continue;
    const qty = Number(raw);
    if (Number.isNaN(qty)) continue;
    out.push({ name, qty });
  }
  return out;
}

async function main() {
  const file = process.argv[2] || 'Нижний склад 16.xlsx';
  const location = process.argv[3] || 'Нижний';

  const wb = XLSX.readFile(file);
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
  const items = parseStockRows(rows);
  console.log(`[importStock] Файл «${file}», лист «${wb.SheetNames[0]}»: позиций к импорту — ${items.length} (склад «${location}»).`);

  const { stockUpsertSet, getPool, dbQuery } = require('../src/services/mysql');

  // Самодостаточность: создаём таблицу, если бот ещё не стартовал с новой схемой
  // (то же DDL, что в initTables; CREATE TABLE IF NOT EXISTS — без конфликта).
  await dbQuery(`
    CREATE TABLE IF NOT EXISTS orch_stock (
      id         INT AUTO_INCREMENT PRIMARY KEY,
      location   VARCHAR(32)   NOT NULL DEFAULT 'Нижний',
      name       VARCHAR(255)  NOT NULL,
      norm_key   VARCHAR(190)  NOT NULL,
      qty        DECIMAL(12,3) NOT NULL DEFAULT 0,
      unit       VARCHAR(16)   NOT NULL DEFAULT 'шт',
      updated_at TIMESTAMP     DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      updated_by VARCHAR(64)   NULL,
      UNIQUE KEY uniq_loc_key (location, norm_key),
      INDEX idx_stock_norm (norm_key)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  let ok = 0;
  for (const it of items) {
    try {
      await stockUpsertSet(location, it.name, it.qty, 'шт', 'import');
      ok++;
    } catch (err) {
      console.error(`  ✗ ${it.name}: ${err.message}`);
    }
  }
  console.log(`[importStock] Импортировано/обновлено: ${ok} из ${items.length}.`);
  try { await getPool().end(); } catch (_) { /* пул мог не открыться */ }
}

// Запуск как скрипт — выполняем; как require (тесты) — только экспорт.
if (require.main === module) {
  main().then(() => process.exit(0)).catch((err) => { console.error(err); process.exit(1); });
}

module.exports = { parseStockRows };

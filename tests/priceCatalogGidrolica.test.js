'use strict';
// Парсер прайса Gidrolica («Прайс гидро июль 2025 РОЗНИЦА»). Проверяется на
// реальном xlsx из корня репозитория (имя файла может быть в NFD — ищем в NFC).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

function findFile() {
  const root = path.join(__dirname, '..');
  const file = fs.readdirSync(root).find((name) => /гидро.*июль.*2025.*розница.*\.xlsx$/iu.test(name.normalize('NFC')));
  return file ? path.join(root, file) : null;
}

test('парсер Gidrolica: лист «Пластик ТДЕ», 81 позиция, розница без скидок', () => {
  const { parsePriceWorkbook } = require('../src/services/priceCatalog');
  const file = findFile();
  assert.ok(file, 'прайс Gidrolica XLSX должен находиться в корне репозитория');
  const parsed = parsePriceWorkbook(file, 'gidrolica');

  assert.equal(parsed.supplier, 'gidrolica');
  assert.equal(parsed.sheet, 'Пластик ТДЕ');
  assert.equal(parsed.price_date, '2025-07-01');
  assert.equal(parsed.items.length, 81);
  assert.equal(new Set(parsed.items.map((x) => x.sku)).size, 81);

  // У Gidrolica нет скидочной цены и поддонов; аномалия «строка-секция с 0 в цене» отсеяна.
  assert.ok(parsed.items.every((x) => x.discount_price === null), 'discount_price должен быть null у всех');
  assert.ok(parsed.items.every((x) => x.pallet_qty === null), 'pallet_qty должен быть null у всех');
  assert.ok(parsed.items.every((x) => x.retail_price > 0), 'не должно быть нулевых цен');
  assert.equal(parsed.items.filter((x) => /^GD-/.test(x.sku)).length, 0, 'в текущем файле нет позиций без артикула');

  // Спот-чек обычной позиции (лоток Light DN100).
  const light = parsed.items.find((x) => x.sku === '080096');
  assert.ok(light, 'нет артикула 080096');
  assert.equal(light.retail_price, 6600);
  assert.equal(light.dn, 'DN100');
  assert.equal(light.series, 'Light');
  assert.equal(light.load_class, 'A15');
  assert.equal(light.length_mm, 1000);
  assert.equal(light.width_mm, 114.5);
  assert.equal(light.height_mm, 55);
  assert.equal(light.weight_kg, 1.4);

  // DN с пробелом в файле («DN150/ 200») нормализуется.
  const pesk = parsed.items.find((x) => x.sku === '828');
  assert.ok(pesk, 'нет артикула 828');
  assert.equal(pesk.dn, 'DN150/200');

  // Колонка DN = «шт.» → DN берётся из заголовка секции.
  const adapter = parsed.items.find((x) => x.sku === '18062');
  assert.ok(adapter, 'нет артикула 18062');
  assert.equal(adapter.dn, 'DN100');

  // Заголовок секции попадает в norm_key — «пескоуловитель» ищется.
  assert.ok(parsed.items.some((x) => /пескоуловител/.test(x.norm_key)), 'нет «пескоуловитель» в norm_key');

  // Коллизия артикулов с Аквастоком: 1101 есть и здесь.
  const collision = parsed.items.find((x) => x.sku === '1101');
  assert.ok(collision, 'нет артикула 1101 (коллизия с Аквастоком)');
  assert.equal(collision.retail_price, 18000);
  assert.equal(collision.series, 'VS LINE');
});

test('detectSupplier различает файлы по имени листа', () => {
  const XLSX = require('xlsx');
  const { detectSupplier } = require('../src/services/priceCatalog');
  const file = findFile();
  assert.ok(file);
  const wb = XLSX.read(fs.readFileSync(file), { type: 'buffer', bookSheets: true });
  assert.equal(detectSupplier(wb), 'gidrolica');
  assert.equal(detectSupplier({ SheetNames: ['Norma с ТТ'] }), 'aquastok');
  assert.equal(detectSupplier({ SheetNames: ['Другой лист'] }), null);
});

test('parsePriceWorkbook с чужим supplier падает на отсутствующем листе', () => {
  const { parsePriceWorkbook } = require('../src/services/priceCatalog');
  const file = findFile();
  assert.ok(file);
  assert.throws(() => parsePriceWorkbook(file, 'aquastok'), /price_workbook_missing_sheet:Norma с ТТ/);
  assert.throws(() => parsePriceWorkbook(file, 'nope'), /price_workbook_unknown_supplier/);
});

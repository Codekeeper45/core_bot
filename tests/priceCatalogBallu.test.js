'use strict';
// Парсер прайса Ballu ONEAIR («Ballu_ONEAIR 16.02.2026_D,D1.XLSX»). Проверяется
// на реальном xlsx из корня репозитория. Три цены: РРЦ (retail — база расчёта),
// дилерские Д/Д1 (закупочные, справочно). Лист «Конкуренты» игнорируется.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

function findFile() {
  const root = path.join(__dirname, '..');
  const file = fs.readdirSync(root).find((name) => /ballu.*oneair.*\.xlsx$/iu.test(name.normalize('NFC')));
  return file ? path.join(root, file) : null;
}

test('парсер Ballu: лист ONEAIR, 28 позиций, РРЦ + дилерские Д/Д1', () => {
  const { parsePriceWorkbook } = require('../src/services/priceCatalog');
  const file = findFile();
  assert.ok(file, 'прайс Ballu XLSX должен находиться в корне репозитория');
  const parsed = parsePriceWorkbook(file, 'ballu');

  assert.equal(parsed.supplier, 'ballu');
  assert.equal(parsed.sheet, 'ONEAIR');
  assert.equal(parsed.price_date, '2026-02-16');
  assert.equal(parsed.items.length, 28);
  assert.equal(new Set(parsed.items.map((x) => x.sku)).size, 28);

  // discount_price ПУСТОЙ у всех: расчёт КП должен идти по РРЦ, а не по закупке.
  assert.ok(parsed.items.every((x) => x.discount_price === null), 'discount_price должен быть null');
  assert.ok(parsed.items.every((x) => x.retail_price > 0));
  assert.ok(parsed.items.every((x) => x.dealer_price > 0 && x.dealer_price_2 > 0), 'дилерские Д/Д1 у всех позиций');
  assert.ok(parsed.items.every((x) => x.dealer_price_2 < x.dealer_price && x.dealer_price < x.retail_price),
    'Д1 < Д < РРЦ');

  // Спот-чек: очиститель ASP-200S.
  const it = parsed.items.find((x) => x.sku === 'НС-1428459');
  assert.ok(it, 'нет НС-1428459');
  assert.equal(it.retail_price, 327590);
  assert.equal(it.dealer_price, 262072);
  assert.equal(it.dealer_price_2, 245693);
  assert.equal(it.series, 'ONEAIR ASP-200Х');
  assert.match(it.name, /ONEAIR ASP-200S/);

  // Секции из повторяющихся заголовков «НС-код».
  const sections = new Set(parsed.items.map((x) => x.series));
  assert.ok(sections.has('ONEAIR ASP-100'));
  assert.ok(sections.has('Опции и фильтры для ASP-200, ASP-100, ASP-80'));

  // Примечание (кол.3) попадает в norm_key — «фильтр для ASP-100» ищется.
  const filter100 = parsed.items.find((x) => /фильтр/.test(x.norm_key) && /asp 100/.test(x.norm_key));
  assert.ok(filter100, 'фильтр для ASP-100 должен находиться по norm_key');

  // Служебные строки-заголовки «НС-код» не попали в позиции.
  assert.ok(parsed.items.every((x) => x.sku !== 'НС-код'));
});

test('detectSupplier узнаёт Ballu по листу ONEAIR', () => {
  const { detectSupplier } = require('../src/services/priceCatalog');
  assert.equal(detectSupplier({ SheetNames: ['ONEAIR', 'Конкуренты'] }), 'ballu');
});

test('чужой supplier на файле Ballu падает по отсутствию листа', () => {
  const { parsePriceWorkbook } = require('../src/services/priceCatalog');
  const file = findFile();
  assert.ok(file);
  assert.throws(() => parsePriceWorkbook(file, 'gidrolica'), /price_workbook_missing_sheet:Пластик ТДЕ/);
});

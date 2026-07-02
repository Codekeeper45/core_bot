'use strict';
// Регрессия по РЕАЛЬНЫМ файлам обоих прайсов: Аквасток/Norma (янв 2026) и
// Gidrolica (июль 2025) живут в каталоге ОДНОВРЕМЕННО; поиск идёт по обоим,
// артикулы-коллизии дают ambiguous, расчёт Gidrolica — по рознице.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const Module = require('module');
const { normKey } = require('../src/utils/stockKey');

function normalizeSku(sku) {
  return String(sku || '').trim().toUpperCase().replace(/С/g, 'C');
}

function loadItems(regex, supplier, priceDate) {
  const { parsePriceWorkbook } = require('../src/services/priceCatalog');
  const root = path.join(__dirname, '..');
  const file = fs.readdirSync(root).find((name) => regex.test(name.normalize('NFC')));
  assert.ok(file, `прайс (${supplier}) должен быть в корне репозитория`);
  return parsePriceWorkbook(path.join(root, file), supplier).items.map((x) => ({
    ...x,
    supplier,
    series_name: x.series,
    source_file: file,
    price_date: priceDate,
    active: 1,
  }));
}

function search(items, query, limit = 20, supplier = null) {
  const tokens = normKey(query).split(' ').filter(Boolean).slice(0, 8);
  return items
    .filter((item) => !supplier || item.supplier === supplier)
    .filter((item) => tokens.every((token) => item.norm_key.includes(token)))
    .sort((a, b) => a.supplier.localeCompare(b.supplier) || String(a.sku).localeCompare(String(b.sku), 'ru'))
    .slice(0, limit);
}

test('регрессия: оба прайса активны, поиск по обоим, коллизии ambiguous, Gidrolica по рознице', async () => {
  const aqItems = loadItems(/аквасток.*январь.*2026.*продажн.*\.xlsx$/iu, 'aquastok', '2026-01-01');
  const gdItems = loadItems(/гидро.*июль.*2025.*розница.*\.xlsx$/iu, 'gidrolica', '2025-07-01');
  const items = [...aqItems, ...gdItems];

  const mysqlMock = {
    priceGetBySku: async (sku, supplier = null) => items
      .filter((x) => normalizeSku(x.sku) === normalizeSku(sku))
      .filter((x) => !supplier || x.supplier === supplier)
      .sort((a, b) => a.supplier.localeCompare(b.supplier))
      .slice(0, 5),
    priceSearch: async (query, limit, supplier = null) => search(items, query, limit, supplier),
  };

  const orig = Module.prototype.require;
  delete require.cache[require.resolve('../src/tools/priceCatalog')];
  Module.prototype.require = function (id) {
    if (id === '../services/mysql') return mysqlMock;
    return orig.apply(this, arguments);
  };
  const { handler } = require('../src/tools/priceCatalog');
  Module.prototype.require = orig;

  // Артикулы, существующие в ОБОИХ каталогах (реальная коллизия: 1101).
  const aqSkus = new Set(aqItems.map((x) => normalizeSku(x.sku)));
  const collisions = new Set(gdItems.map((x) => normalizeSku(x.sku)).filter((s) => aqSkus.has(s)));
  assert.ok(collisions.has('1101'), 'коллизия 1101 должна существовать в обоих прайсах');

  let checks = 0;
  // Каждая позиция находится точным sku в СВОЁМ каталоге.
  for (const item of items) {
    const found = await mysqlMock.priceGetBySku(item.sku, item.supplier);
    assert.equal(found.length, 1, `exact sku not found: ${item.supplier}/${item.sku}`);
    checks++;
  }

  for (const sku of ['11005', '11007', '11012', '11015', '11018', '11042', '9270', '9212', '91102V', '911011', '31013B', '31513C', '32023C', '4300', '4330']) {
    const found = await mysqlMock.priceGetBySku(sku, 'aquastok');
    assert.equal(found.length, 1, `reported missing sku not found: ${sku}`);
    assert.ok(found[0].discount_price != null, `missing discount price: ${sku}`);
    checks++;
  }

  for (const query of [
    'AQUASTOK', 'Norma', 'Master', 'DN100', 'DN150', 'DN200', 'DN90',
    'А', 'В', 'С', 'решетка Norma DN200', 'дождеприемник',
    'пескоуловитель', 'фиксатор DN100', 'ливнеприемник',
  ]) {
    const rows = await mysqlMock.priceSearch(query, 20);
    assert.ok(rows.length > 0, `query returned nothing: ${query}`);
    checks++;
  }

  // Gidrolica теперь В КАТАЛОГЕ — эти запросы обязаны находить её позиции.
  for (const query of ['Gidrolica Light', '080096', 'пескоуловитель gidrolica standart']) {
    const rows = await mysqlMock.priceSearch(query, 20);
    assert.ok(rows.length > 0, `Gidrolica query must return rows now: ${query}`);
    assert.ok(rows.every((x) => x.supplier === 'gidrolica'), `unexpected supplier for: ${query}`);
    checks++;
  }

  // Поиск DN100 без фильтра видит ОБА каталога; supplier-фильтр сужает.
  const dnBoth = await mysqlMock.priceSearch('DN100', 50);
  assert.equal(new Set(dnBoth.map((x) => x.supplier)).size, 2, 'DN100 должен находиться в обоих прайсах');
  const dnOnly = await mysqlMock.priceSearch('DN100', 50, 'gidrolica');
  assert.ok(dnOnly.length > 0 && dnOnly.every((x) => x.supplier === 'gidrolica'));
  checks++;

  for (const [sku, qty] of [['11005', 10], ['11042', 2], ['31513C', 4], ['32023C', 3], ['4330', 5]]) {
    const result = await handler({ action: 'calculate', lines: [{ query: sku, qty }] });
    const item = (await mysqlMock.priceGetBySku(sku, 'aquastok'))[0];
    assert.equal(result.success, true);
    assert.equal(result.price_basis, 'discount');
    assert.equal(result.total, Number((Number(item.discount_price) * qty).toFixed(2)));
    checks++;
  }

  // Коллизия артикулов: без supplier расчёт честно просит уточнить.
  const collision = await handler({ action: 'calculate', lines: [{ query: '1101', qty: 1 }] });
  assert.equal(collision.success, false);
  assert.equal(collision.reason, 'ambiguous');
  assert.equal(collision.candidates.length, 2);
  checks++;

  // С supplier=gidrolica расчёт идёт по рознице (скидочной цены нет).
  const gd1101 = (await mysqlMock.priceGetBySku('1101', 'gidrolica'))[0];
  const gdCalc = await handler({ action: 'calculate', supplier: 'gidrolica', lines: [{ query: '1101', qty: 2 }] });
  assert.equal(gdCalc.success, true);
  assert.equal(gdCalc.lines[0].price_basis, 'retail');
  assert.equal(gdCalc.lines[0].unit_price, Number(gd1101.retail_price));
  assert.equal(gdCalc.total, Number((Number(gd1101.retail_price) * 2).toFixed(2)));
  checks++;

  assert.equal(checks, items.length + 15 + 15 + 3 + 1 + 5 + 1 + 1);

  // Считаем по позициям с реальным артикулом и скидочной ценой (без коллизий):
  // отображаемый артикул (sku в выдаче) совпадает с настоящим.
  const calcItems = aqItems
    .filter((x) => !/^AQ-/.test(x.sku) && x.discount_price != null && !collisions.has(normalizeSku(x.sku)))
    .slice(0, 27);
  assert.equal(calcItems.length, 27, 'должно хватать обычных позиций со скидкой');
  for (const item of calcItems) {
    const result = await handler({ action: 'calculate', lines: [{ query: item.sku, qty: 1 }] });
    assert.equal(result.success, true);
    assert.equal(result.lines[0].sku, item.sku);
    assert.equal(result.lines[0].unit_price, item.discount_price);
    assert.equal(result.lines[0].supplier, 'aquastok');
    checks++;
  }

  assert.equal(checks, items.length + 41 + 27);
});

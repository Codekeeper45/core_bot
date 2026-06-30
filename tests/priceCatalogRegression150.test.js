'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const Module = require('module');
const { normKey } = require('../src/utils/stockKey');

function normalizeSku(sku) {
  return String(sku || '').trim().toUpperCase().replace(/С/g, 'C');
}

function loadItems() {
  const { parsePriceWorkbook } = require('../src/services/priceCatalog');
  const root = path.join(__dirname, '..');
  const file = fs.readdirSync(root).find((name) => /аквасток.*январь.*2026.*продажн.*\.xlsx$/iu.test(name.normalize('NFC')));
  assert.ok(file, 'прайс Аквасток должен быть в корне репозитория');
  return parsePriceWorkbook(path.join(root, file)).items.map((x) => ({
    ...x,
    series_name: x.series,
    source_file: file,
    price_date: '2026-01-01',
    active: 1,
  }));
}

function search(items, query, limit = 20) {
  const tokens = normKey(query).split(' ').filter(Boolean).slice(0, 8);
  return items
    .filter((item) => tokens.every((token) => item.norm_key.includes(token)))
    .sort((a, b) => String(a.sku).localeCompare(String(b.sku), 'ru'))
    .slice(0, limit);
}

test('регрессия 1-150: Аквасток видит артикулы, DN/классы и считает по скидке', async () => {
  const items = loadItems();
  const mysqlMock = {
    priceGetBySku: async (sku) => items.find((x) => normalizeSku(x.sku) === normalizeSku(sku)) || null,
    priceSearch: async (query, limit) => search(items, query, limit),
  };

  const orig = Module.prototype.require;
  delete require.cache[require.resolve('../src/tools/priceCatalog')];
  Module.prototype.require = function (id) {
    if (id === '../services/mysql') return mysqlMock;
    return orig.apply(this, arguments);
  };
  const { handler } = require('../src/tools/priceCatalog');
  Module.prototype.require = orig;

  let checks = 0;
  for (const item of items) {
    const found = await mysqlMock.priceGetBySku(item.sku);
    assert.ok(found, `exact sku not found: ${item.sku}`);
    assert.notEqual(found.name.toLowerCase(), 'gidrolica');
    checks++;
  }

  for (const sku of ['11005', '11007', '11012', '11015', '11018', '11042', '9270', '9212', '91102V', '911011', '31013B', '31513C', '32023C', '4300', '4330']) {
    const found = await mysqlMock.priceGetBySku(sku);
    assert.ok(found, `reported missing sku not found: ${sku}`);
    assert.ok(found.discount_price != null, `missing discount price: ${sku}`);
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

  for (const [sku, qty] of [['11005', 10], ['11042', 2], ['31513C', 4], ['32023C', 3], ['4330', 5]]) {
    const result = await handler({ action: 'calculate', lines: [{ query: sku, qty }] });
    const item = await mysqlMock.priceGetBySku(sku);
    assert.equal(result.success, true);
    assert.equal(result.price_basis, 'discount');
    assert.equal(result.total, Number((Number(item.discount_price) * qty).toFixed(2)));
    checks++;
  }

  for (const query of ['Gidrolica Light', '080096', 'гидролика дн200']) {
    const rows = await mysqlMock.priceSearch(query, 20);
    assert.equal(rows.length, 0, `Gidrolica query should be inactive: ${query}`);
    checks++;
  }

  assert.equal(checks, items.length + 38);

  // Считаем по позициям с реальным артикулом и скидочной ценой: для них
  // отображаемый артикул (sku в выдаче) совпадает с настоящим.
  const calcItems = items.filter((x) => !/^AQ-/.test(x.sku) && x.discount_price != null).slice(0, 27);
  assert.equal(calcItems.length, 27, 'должно хватать обычных позиций со скидкой');
  for (const item of calcItems) {
    const result = await handler({ action: 'calculate', lines: [{ query: item.sku, qty: 1 }] });
    assert.equal(result.success, true);
    assert.equal(result.lines[0].sku, item.sku);
    assert.equal(result.lines[0].unit_price, item.discount_price);
    checks++;
  }

  assert.equal(checks, items.length + 38 + 27);
});

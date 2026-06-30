'use strict';

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');

const items = [
  { sku: '11005', name: 'Лоток водоотводный пластиковый ЛВП Norma DN100 H55', dn: 'DN100', load_class: 'А, В, С', retail_price: 3600, discount_price: 3060, currency: 'KZT', source_file: 'aquastok.xlsx', price_date: '2026-01-01' },
  { sku: '11007', name: 'Лоток водоотводный пластиковый ЛВП Norma DN100 H70', dn: 'DN100', load_class: 'А, В, С', retail_price: 4300, discount_price: 3655, currency: 'KZT', source_file: 'aquastok.xlsx', price_date: '2026-01-01' },
  { sku: '31513С', name: 'Решетка чугунная щелевая РЧЩ Norma DN150 C250', dn: 'DN150', load_class: 'А, В, С', retail_price: 17000, discount_price: 14450, currency: 'KZT', source_file: 'aquastok.xlsx', price_date: '2026-01-01' },
  { sku: 'AQ-NOVINKA-R031', source_sku: 'новинка', name: 'Решетка пластиковая косичка РПК Norma DN100', dn: 'DN100', retail_price: 5000, discount_price: 4250, currency: 'KZT', source_file: 'aquastok.xlsx', price_date: '2026-01-01' },
  { sku: 'AQ-NOART-R118', source_sku: null, name: 'Крепящий якорь к бордюру Кантри', retail_price: 900, discount_price: 765, currency: 'KZT', source_file: 'aquastok.xlsx', price_date: '2026-01-01' },
];
function normalizeSku(sku) {
  return String(sku || '').trim().toUpperCase().replace(/С/g, 'C');
}
const mysqlMock = {
  priceGetBySku: async (sku) => items.find((x) => normalizeSku(x.sku) === normalizeSku(sku)) || null,
  priceSearch: async (q) => items.filter((x) => normalizeSku(x.sku) === normalizeSku(q)
    || `${x.sku} ${x.name} ${x.dn} ${x.load_class}`.toLowerCase().includes(String(q).toLowerCase())),
};
const orig = Module.prototype.require;
Module.prototype.require = function (id) {
  if (id === '../services/mysql') return mysqlMock;
  return orig.apply(this, arguments);
};
const { handler } = require('../../src/tools/priceCatalog');
Module.prototype.require = orig;

beforeEach(() => {});

test('price_catalog рассчитывает сумму по скидочной цене по умолчанию', async () => {
  const result = await handler({ action: 'calculate', lines: [{ query: '11005', qty: 3 }] });
  assert.equal(result.success, true);
  assert.equal(result.total, 9180);
  assert.equal(result.currency, 'KZT');
  assert.equal(result.price_basis, 'discount');
  assert.equal(result.lines[0].sku, '11005');
  assert.equal(result.lines[0].retail_price, 3600);
  assert.equal(result.lines[0].discount_price, 3060);
  assert.equal(result.lines[0].unit_price, 3060);
});

test('price_catalog умеет считать по рознице явно', async () => {
  const result = await handler({ action: 'calculate', price_basis: 'retail', lines: [{ query: '11005', qty: 3 }] });
  assert.equal(result.success, true);
  assert.equal(result.total, 10800);
  assert.equal(result.price_basis, 'retail');
  assert.equal(result.lines[0].unit_price, 3600);
});

test('price_catalog не угадывает неоднозначную позицию', async () => {
  const result = await handler({ action: 'calculate', lines: [{ query: 'DN100', qty: 1 }] });
  assert.equal(result.success, false);
  assert.equal(result.reason, 'ambiguous');
  assert.equal(result.candidates.length, 3);
});

test('price_catalog search находит кириллическую С по латинской C', async () => {
  const result = await handler({ action: 'search', query: '31513C' });
  assert.equal(result.success, true);
  assert.equal(result.count, 1);
  assert.equal(result.items[0].sku, '31513С');
  assert.equal(result.items[0].discount_price, 14450);
});

test('артикул в выдаче: новинка → «новинка», без артикула → null, обычный → как есть', async () => {
  const novelty = await handler({ action: 'search', query: 'косичка' });
  assert.equal(novelty.success, true);
  assert.equal(novelty.items[0].sku, 'новинка', 'синтетический AQ-NOVINKA не должен утекать наружу');

  const noart = await handler({ action: 'search', query: 'якорь к бордюру' });
  assert.equal(noart.success, true);
  assert.equal(noart.items[0].sku, null, 'позиция без артикула → sku null, не AQ-NOART');

  const normal = await handler({ action: 'search', query: '11005' });
  assert.equal(normal.items[0].sku, '11005');
});

'use strict';

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');

const items = [
  { sku: '11005', supplier: 'aquastok', name: 'Лоток водоотводный пластиковый ЛВП Norma DN100 H55', dn: 'DN100', load_class: 'А, В, С', retail_price: 3600, discount_price: 3060, currency: 'KZT', source_file: 'aquastok.xlsx', price_date: '2026-01-01' },
  { sku: '11007', supplier: 'aquastok', name: 'Лоток водоотводный пластиковый ЛВП Norma DN100 H70', dn: 'DN100', load_class: 'А, В, С', retail_price: 4300, discount_price: 3655, currency: 'KZT', source_file: 'aquastok.xlsx', price_date: '2026-01-01' },
  { sku: '31513С', supplier: 'aquastok', name: 'Решетка чугунная щелевая РЧЩ Norma DN150 C250', dn: 'DN150', load_class: 'А, В, С', retail_price: 17000, discount_price: 14450, currency: 'KZT', source_file: 'aquastok.xlsx', price_date: '2026-01-01' },
  { sku: 'AQ-NOVINKA-R031', supplier: 'aquastok', source_sku: 'новинка', name: 'Решетка пластиковая косичка РПК Norma DN100', dn: 'DN100', retail_price: 5000, discount_price: 4250, currency: 'KZT', source_file: 'aquastok.xlsx', price_date: '2026-01-01' },
  { sku: 'AQ-NOART-R118', supplier: 'aquastok', source_sku: null, name: 'Крепящий якорь к бордюру Кантри', retail_price: 900, discount_price: 765, currency: 'KZT', source_file: 'aquastok.xlsx', price_date: '2026-01-01' },
  // Коллизия артикулов между каталогами: 1101 есть и в Аквасток, и в Gidrolica.
  { sku: '1101', supplier: 'aquastok', name: 'Канал водоотводный КВ 12,5*8 DN100', dn: 'DN100', retail_price: 5500, discount_price: 4675, currency: 'KZT', source_file: 'aquastok.xlsx', price_date: '2026-01-01' },
  { sku: '1101', supplier: 'gidrolica', name: 'Лоток водоотводный VS LINE DN100.14.07 с решеткой В125', dn: 'DN100', retail_price: 18000, discount_price: null, currency: 'KZT', source_file: 'gidro.xlsx', price_date: '2025-07-01' },
  { sku: '080096', supplier: 'gidrolica', name: 'Комплект Gidrolica Light: лоток с решеткой оцинкованной, кл. A15', dn: 'DN100', load_class: 'A15', retail_price: 6600, discount_price: null, currency: 'KZT', source_file: 'gidro.xlsx', price_date: '2025-07-01' },
  { sku: 'GD-NOART-R042', supplier: 'gidrolica', source_sku: null, name: 'Заглушка универсальная Gidrolica', retail_price: 700, discount_price: null, currency: 'KZT', source_file: 'gidro.xlsx', price_date: '2025-07-01' },
  { sku: 'НС-1428459', supplier: 'ballu', name: 'Очиститель воздуха приточный Ballu ONEAIR ASP-200S', retail_price: 327590, discount_price: null, dealer_price: 262072, dealer_price_2: 245693, currency: 'KZT', source_file: 'ballu.xlsx', price_date: '2026-02-16' },
];
function normalizeSku(sku) {
  return String(sku || '').trim().toUpperCase().replace(/С/g, 'C');
}
const mysqlMock = {
  priceGetBySku: async (sku, supplier = null) => items
    .filter((x) => normalizeSku(x.sku) === normalizeSku(sku))
    .filter((x) => !supplier || x.supplier === supplier),
  priceSearch: async (q, limit = 20, supplier = null) => items
    .filter((x) => normalizeSku(x.sku) === normalizeSku(q)
      || `${x.sku} ${x.name} ${x.dn} ${x.load_class}`.toLowerCase().includes(String(q).toLowerCase()))
    .filter((x) => !supplier || x.supplier === supplier),
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
  assert.equal(result.mixed_suppliers, false);
  assert.equal(result.lines[0].sku, '11005');
  assert.equal(result.lines[0].supplier, 'aquastok');
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
  assert.ok(result.candidates.length >= 3);
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

  const gdNoart = await handler({ action: 'search', query: 'заглушка универсальная' });
  assert.equal(gdNoart.success, true);
  assert.equal(gdNoart.items[0].sku, null, 'GD-NOART тоже не утекает наружу');

  const normal = await handler({ action: 'search', query: '11005' });
  assert.equal(normal.items[0].sku, '11005');
});

test('артикул в обоих каталогах → ambiguous с кандидатами разных поставщиков', async () => {
  const result = await handler({ action: 'calculate', lines: [{ query: '1101', qty: 1 }] });
  assert.equal(result.success, false);
  assert.equal(result.reason, 'ambiguous');
  assert.equal(result.candidates.length, 2);
  const suppliers = new Set(result.candidates.map((c) => c.supplier));
  assert.deepEqual([...suppliers].sort(), ['aquastok', 'gidrolica']);
});

test('supplier-фильтр снимает неоднозначность; Gidrolica считается по рознице', async () => {
  const result = await handler({ action: 'calculate', supplier: 'gidrolica', lines: [{ query: '1101', qty: 2 }] });
  assert.equal(result.success, true);
  assert.equal(result.lines[0].supplier, 'gidrolica');
  assert.equal(result.lines[0].supplier_label, 'Gidrolica (июль 2025)');
  assert.equal(result.lines[0].price_basis, 'retail', 'у Gidrolica нет скидочной цены');
  assert.equal(result.lines[0].unit_price, 18000);
  assert.equal(result.total, 36000);
  assert.equal(result.lines[0].price_date, '2025-07-01');
});

test('search по supplier сужает выдачу до одного каталога', async () => {
  const all = await handler({ action: 'search', query: 'DN100' });
  assert.ok(new Set(all.items.map((x) => x.supplier)).size > 1, 'без фильтра — оба каталога');
  const only = await handler({ action: 'search', query: 'DN100', supplier: 'aquastok' });
  assert.ok(only.items.length > 0);
  assert.ok(only.items.every((x) => x.supplier === 'aquastok'));
});

test('смешанный расчёт двух поставщиков помечается mixed_suppliers', async () => {
  const result = await handler({
    action: 'calculate',
    lines: [{ query: '11005', qty: 1 }, { query: '080096', qty: 1 }],
  });
  assert.equal(result.success, true);
  assert.equal(result.mixed_suppliers, true);
  assert.match(result.note, /РАЗНЫХ поставщиков/);
});

test('Ballu: расчёт по РРЦ, дилерские Д/Д1 отдаются справочно и не влияют на сумму', async () => {
  const result = await handler({ action: 'calculate', supplier: 'ballu', lines: [{ query: 'НС-1428459', qty: 2 }] });
  assert.equal(result.success, true);
  assert.equal(result.lines[0].supplier_label, 'Ballu ONEAIR (16.02.2026)');
  assert.equal(result.lines[0].price_basis, 'retail', 'discount_price пуст → база РРЦ');
  assert.equal(result.lines[0].unit_price, 327590, 'НЕ по дилерской закупке');
  assert.equal(result.total, 655180);
  assert.equal(result.lines[0].dealer_price, 262072);
  assert.equal(result.lines[0].dealer_price_2, 245693);
});

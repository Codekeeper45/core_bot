'use strict';

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');

const items = [
  { sku: '11005', supplier: 'aquastok', name: 'Лоток Norma DN100 H55', dn: 'DN100', length_mm: 1000, width_mm: 148, height_mm: 55, retail_price: 3600, discount_price: 3060 },
  { sku: 'GD-10', supplier: 'gidrolica', name: 'Лоток Gidrolica DN100', dn: 'DN100', length_mm: 1000, width_mm: 145, height_mm: 180, retail_price: 4830, discount_price: null },
  { sku: '1101', supplier: 'aquastok', name: 'Канал Norma DN100', dn: 'DN100', retail_price: 5500, discount_price: 4675 },
  { sku: '1101', supplier: 'gidrolica', name: 'Канал Gidrolica DN100', dn: 'DN100', retail_price: 18000, discount_price: null },
];
const rendered = [];
const delivered = [];
const mysqlMock = {
  priceGetBySku: async (sku, supplier = null) => items.filter((item) => item.sku === sku && (!supplier || item.supplier === supplier)),
  priceSearch: async (query, limit, supplier = null) => items.filter((item) => item.name.toLowerCase().includes(String(query).toLowerCase()) && (!supplier || item.supplier === supplier)).slice(0, limit),
};

const originalRequire = Module.prototype.require;
Module.prototype.require = function (id) {
  if (id === '../services/mysql') return mysqlMock;
  if (id === '../services/notifier') return { deliver: async (...args) => { delivered.push(args); return true; } };
  if (id === '../services/quoteWorkbook') return { MAX_LINES: 50, TERMS_SLOTS: 7, renderQuote: async (data) => { rendered.push(data); return Buffer.from('xlsx'); } };
  return originalRequire.apply(this, arguments);
};
const { handler } = require('../../src/tools/generateQuote');
Module.prototype.require = originalRequire;

const request = (lines) => ({
  quote_number: '3-2206',
  recipient: 'ТОО Клиент',
  offer_date: '2026-07-09',
  terms: ['Оплата: предоплата 100%.'],
  lines,
});

beforeEach(() => { rendered.length = 0; delivered.length = 0; });

test('generate_quote берёт розничную цену Аквасток и отправляет XLSX', async () => {
  const result = await handler(request([{ query: '11005', qty: 3 }]), { channel: 'telegram', chatId: '42' });
  assert.equal(result.success, true);
  assert.equal(result.total, 10800);
  assert.equal(result.lines[0].price_basis, 'retail');
  assert.equal(rendered[0].lines[0].unit_price, 3600);
  assert.equal(delivered[0][0], 'telegram');
  assert.equal(delivered[0][3].mimetype, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  assert.match(delivered[0][3].fileName, /КП Неодрейн 3-2206\.xlsx/);
});

test('generate_quote требует подтверждение для смешения поставщиков', async () => {
  const args = request([{ query: '11005', qty: 1 }, { query: 'GD-10', qty: 1, supplier: 'gidrolica' }]);
  const blocked = await handler(args, { channel: 'whatsapp', chatId: '7700' });
  assert.equal(blocked.reason, 'mixed_suppliers_confirmation_required');
  assert.equal(delivered.length, 0);

  const confirmed = await handler({ ...args, allow_mixed_suppliers: true }, { channel: 'whatsapp', chatId: '7700' });
  assert.equal(confirmed.success, true);
  assert.equal(confirmed.lines[1].price_basis, 'retail');
});

test('generate_quote не угадывает артикул из двух прайсов', async () => {
  const result = await handler(request([{ query: '1101', qty: 1 }]), { channel: 'telegram', chatId: '42' });
  assert.equal(result.success, false);
  assert.equal(result.reason, 'ambiguous');
  assert.equal(delivered.length, 0);
});

test('generate_quote не формирует документ в Instagram', async () => {
  const result = await handler(request([{ query: '11005', qty: 1 }]), { channel: 'instagram', chatId: 'user' });
  assert.equal(result.reason, 'channel_unsupported');
  assert.equal(delivered.length, 0);
});

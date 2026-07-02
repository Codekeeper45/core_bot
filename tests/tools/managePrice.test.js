'use strict';
const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { normKey } = require('../../src/utils/stockKey');

// In-memory мок прайса: только активные позиции «живые». Два поставщика.
const db = { items: [], nextId: 1, changes: [], nextChangeId: 1 };

function normalizeSku(sku) {
  return String(sku || '').trim().toUpperCase().replace(/С/g, 'C');
}

function findActive(sku, supplier = null) {
  const wanted = normalizeSku(sku);
  return db.items.filter((p) => p.active && normalizeSku(p.sku) === wanted && (!supplier || p.supplier === supplier));
}
function actorName(a) {
  return a && typeof a === 'object' ? (a.clientName || a.name || a.chatId || null) : (a || null);
}
function logChange(c) { db.changes.unshift({ id: db.nextChangeId++, ...c }); }

// Мутации повторяют контракт mysql: supplier 4-м аргументом, при двух
// совпадениях без supplier → ambiguous_supplier.
function pickOne(sku, supplier) {
  const rows = findActive(sku, supplier);
  if (!rows.length) return { item: null };
  if (rows.length > 1) return { item: null, ambiguous: true, suppliers: rows.map((r) => r.supplier) };
  return { item: rows[0] };
}

const mysqlMock = {
  priceGetBySku: async (sku, supplier = null) => findActive(sku, supplier),
  priceSearch: async (query, limit = 20, supplier = null) => {
    const toks = normKey(query).split(' ').filter(Boolean);
    return db.items
      .filter((p) => p.active && toks.every((t) => p.norm_key.includes(t)))
      .filter((p) => !supplier || p.supplier === supplier)
      .slice(0, limit);
  },
  priceSetPrice: async (sku, newPrice, actor = {}, supplier = null) => {
    const price = Number(newPrice);
    if (!Number.isFinite(price) || price < 0) return { ok: false, reason: 'invalid_price' };
    const found = pickOne(sku, supplier);
    if (found.ambiguous) return { ok: false, reason: 'ambiguous_supplier', suppliers: found.suppliers };
    if (!found.item) return { ok: false, reason: 'not_found' };
    const it = found.item;
    const old = Number(it.retail_price); it.retail_price = price;
    logChange({ sku: it.sku, supplier: it.supplier, change_type: 'set_price', old_price: old, new_price: price, actor_name: actorName(actor) });
    return { ok: true, sku: it.sku, supplier: it.supplier, name: it.name, old_price: old, new_price: price, currency: it.currency };
  },
  priceSetDiscountPrice: async (sku, newPrice, actor = {}, supplier = null) => {
    const price = Number(newPrice);
    if (!Number.isFinite(price) || price < 0) return { ok: false, reason: 'invalid_price' };
    const found = pickOne(sku, supplier);
    if (found.ambiguous) return { ok: false, reason: 'ambiguous_supplier', suppliers: found.suppliers };
    if (!found.item) return { ok: false, reason: 'not_found' };
    const it = found.item;
    const old = it.discount_price == null ? null : Number(it.discount_price); it.discount_price = price;
    logChange({ sku: it.sku, supplier: it.supplier, change_type: 'set_discount', old_discount_price: old, new_discount_price: price, actor_name: actorName(actor) });
    return { ok: true, sku: it.sku, supplier: it.supplier, name: it.name, old_discount_price: old, new_discount_price: price, currency: it.currency };
  },
  priceAddItem: async (data = {}, actor = {}) => {
    const sku = String(data.sku || '').trim();
    const name = String(data.name || '').trim();
    const supplier = String(data.supplier || '').trim();
    const price = Number(data.retail_price);
    const discount = data.discount_price == null ? null : Number(data.discount_price);
    if (!sku || !name) return { ok: false, reason: 'sku_name_required' };
    if (!supplier) return { ok: false, reason: 'supplier_required' };
    if (!Number.isFinite(price) || price < 0) return { ok: false, reason: 'invalid_price' };
    if (discount != null && (!Number.isFinite(discount) || discount < 0)) return { ok: false, reason: 'invalid_discount_price' };
    if (findActive(sku, supplier).length) return { ok: false, reason: 'exists' };
    const key = normKey([sku, data.series, data.load_class, name, data.dn].filter(Boolean).join(' '));
    const it = { id: db.nextId++, sku, supplier, name, series_name: data.series || null, load_class: data.load_class || null, dn: data.dn || null, retail_price: price, discount_price: discount, currency: data.currency || 'KZT', active: 1, norm_key: key };
    db.items.push(it);
    logChange({ sku, supplier, change_type: 'add', new_price: price, new_discount_price: discount, new_name: name, actor_name: actorName(actor) });
    return { ok: true, id: it.id, sku, supplier, name, retail_price: price, discount_price: discount, currency: it.currency };
  },
  priceRemove: async (sku, actor = {}, supplier = null) => {
    const found = pickOne(sku, supplier);
    if (found.ambiguous) return { ok: false, reason: 'ambiguous_supplier', suppliers: found.suppliers };
    if (!found.item) return { ok: false, reason: 'not_found' };
    const it = found.item;
    it.active = 0;
    logChange({ sku: it.sku, supplier: it.supplier, change_type: 'remove', old_price: it.retail_price, old_name: it.name, actor_name: actorName(actor) });
    return { ok: true, sku: it.sku, supplier: it.supplier, name: it.name };
  },
  priceRename: async (sku, newName, actor = {}, supplier = null) => {
    const name = String(newName || '').trim();
    if (!name) return { ok: false, reason: 'name_required' };
    const found = pickOne(sku, supplier);
    if (found.ambiguous) return { ok: false, reason: 'ambiguous_supplier', suppliers: found.suppliers };
    if (!found.item) return { ok: false, reason: 'not_found' };
    const it = found.item;
    const old = it.name; it.name = name;
    it.norm_key = normKey([it.sku, it.series_name, it.load_class, name, it.dn].filter(Boolean).join(' '));
    logChange({ sku: it.sku, supplier: it.supplier, change_type: 'rename', old_name: old, new_name: name, actor_name: actorName(actor) });
    return { ok: true, sku: it.sku, supplier: it.supplier, old_name: old, new_name: name };
  },
  priceListChanges: async (sku = null, limit = 50, supplier = null) => db.changes
    .filter((c) => !sku || c.sku.toUpperCase() === String(sku).trim().toUpperCase())
    .filter((c) => !supplier || c.supplier === supplier)
    .slice(0, Math.max(1, Math.min(Number(limit) || 50, 100))),
};

const Module = require('module');
const orig = Module.prototype.require;
Module.prototype.require = function (id) {
  if (id === '../services/mysql') return mysqlMock;
  return orig.apply(this, arguments);
};
const { handler } = require('../../src/tools/managePrice');
Module.prototype.require = orig;

const seed = () => {
  db.items = []; db.nextId = 1; db.changes = []; db.nextChangeId = 1;
  mysqlMock.priceAddItem({ sku: '11005', supplier: 'aquastok', name: 'Лоток Аквасток Norma ДН100Н55', dn: 'DN100', retail_price: 3600, discount_price: 3060 });
  mysqlMock.priceAddItem({ sku: '32023С', supplier: 'aquastok', name: 'Решетка чугунная ячеистая РЧЯ Norma DN200 C250', dn: 'DN200', retail_price: 20000, discount_price: 17000 });
  mysqlMock.priceAddItem({ sku: 'GD-DN200', supplier: 'gidrolica', name: 'Лоток Гидролика ДН200Н230', dn: 'DN200', retail_price: 8100 });
  // Коллизия: один артикул в обоих каталогах.
  mysqlMock.priceAddItem({ sku: '1101', supplier: 'aquastok', name: 'Канал водоотводный КВ DN100', dn: 'DN100', retail_price: 5500, discount_price: 4675 });
  mysqlMock.priceAddItem({ sku: '1101', supplier: 'gidrolica', name: 'Лоток VS LINE DN100.14.07', dn: 'DN100', retail_price: 18000 });
  db.changes = []; db.nextChangeId = 1; // история чистая после сидов
};

describe('manage_price', () => {
  beforeEach(seed);

  test('set_price по sku меняет цену и пишет историю', async () => {
    const r = await handler({ action: 'set_price', sku: '11005', price: 7000 }, { clientName: 'Босс' });
    assert.equal(r.success, true);
    assert.equal(r.old_price, 3600);
    assert.equal(r.new_price, 7000);
    assert.equal(r.supplier, 'aquastok');
    const chk = await handler({ action: 'history', sku: '11005' });
    assert.equal(chk.changes[0].change_type, 'set_price');
    assert.equal(chk.changes[0].actor_name, 'Босс');
  });

  test('set_discount_price меняет скидочную цену и пишет историю', async () => {
    const r = await handler({ action: 'set_discount_price', sku: '11005', discount_price: 3200 }, { clientName: 'Босс' });
    assert.equal(r.success, true);
    assert.equal(r.old_discount_price, 3060);
    assert.equal(r.new_discount_price, 3200);
    const chk = await handler({ action: 'history', sku: '11005' });
    assert.equal(chk.changes[0].change_type, 'set_discount');
  });

  test('set_price несуществующего sku → not_found', async () => {
    const r = await handler({ action: 'set_price', sku: 'NOPE', price: 100 });
    assert.equal(r.success, false);
    assert.equal(r.reason, 'not_found');
  });

  test('set_price с отрицательной ценой → invalid_price', async () => {
    const r = await handler({ action: 'set_price', sku: '11005', price: -5 });
    assert.equal(r.success, false);
    assert.equal(r.reason, 'invalid_price');
  });

  test('set_price без price → price_required', async () => {
    const r = await handler({ action: 'set_price', sku: '11005' });
    assert.equal(r.success, false);
    assert.equal(r.reason, 'price_required');
  });

  test('add новой позиции (с supplier)', async () => {
    const r = await handler({ action: 'add', sku: 'PB-1', supplier: 'aquastok', name: 'Пескоуловитель ДН200', price: 12000 });
    assert.equal(r.success, true);
    assert.equal(r.retail_price, 12000);
    assert.equal(r.discount_price, null);
    assert.equal(r.supplier, 'aquastok');
    const found = await handler({ action: 'set_price', sku: 'PB-1', price: 12500 });
    assert.equal(found.success, true);
  });

  test('add без supplier → supplier_required', async () => {
    const r = await handler({ action: 'add', sku: 'PB-2', name: 'Без каталога', price: 100 });
    assert.equal(r.success, false);
    assert.equal(r.reason, 'supplier_required');
  });

  test('add дубликата артикула → exists', async () => {
    const r = await handler({ action: 'add', sku: '11005', supplier: 'aquastok', name: 'Дубль', price: 1 });
    assert.equal(r.success, false);
    assert.equal(r.reason, 'exists');
  });

  test('add без sku/name → sku_name_required', async () => {
    const r = await handler({ action: 'add', supplier: 'aquastok', name: 'Без артикула', price: 1 });
    assert.equal(r.success, false);
    assert.equal(r.reason, 'sku_name_required');
  });

  test('remove делает позицию недоступной', async () => {
    const r = await handler({ action: 'remove', sku: 'GD-DN200' });
    assert.equal(r.success, true);
    const after = await handler({ action: 'set_price', sku: 'GD-DN200', price: 1 });
    assert.equal(after.reason, 'not_found');
  });

  test('rename меняет имя', async () => {
    const r = await handler({ action: 'rename', sku: '11005', name: 'Лоток Аквасток ДН100 (новый)' });
    assert.equal(r.success, true);
    assert.equal(r.new_name, 'Лоток Аквасток ДН100 (новый)');
  });

  test('неоднозначный query (два DN200) → ambiguous, без мутации', async () => {
    const r = await handler({ action: 'set_price', query: 'DN200', price: 1 });
    assert.equal(r.success, false);
    assert.equal(r.reason, 'ambiguous');
    assert.ok(r.candidates.length >= 2);
    // цены не тронуты
    const a = await handler({ action: 'history' });
    assert.equal(a.changes.length, 0);
  });

  test('артикул в обоих каталогах → ambiguous; supplier снимает неоднозначность', async () => {
    const both = await handler({ action: 'set_price', sku: '1101', price: 19000 });
    assert.equal(both.success, false);
    assert.equal(both.reason, 'ambiguous');
    assert.equal(both.candidates.length, 2);
    assert.deepEqual(both.candidates.map((c) => c.supplier).sort(), ['aquastok', 'gidrolica']);

    const one = await handler({ action: 'set_price', sku: '1101', supplier: 'gidrolica', price: 19000 });
    assert.equal(one.success, true);
    assert.equal(one.supplier, 'gidrolica');
    assert.equal(one.old_price, 18000);
    assert.equal(one.new_price, 19000);
    // Аквасточный 1101 не тронут.
    const aq = findActive('1101', 'aquastok')[0];
    assert.equal(Number(aq.retail_price), 5500);
  });

  test('history фильтруется по supplier', async () => {
    await handler({ action: 'set_price', sku: '1101', supplier: 'gidrolica', price: 19000 });
    await handler({ action: 'set_price', sku: '11005', price: 3700 });
    const gd = await handler({ action: 'history', supplier: 'gidrolica' });
    assert.equal(gd.changes.length, 1);
    assert.equal(gd.changes[0].supplier, 'gidrolica');
  });

  test('resolve по query c одним совпадением → set_price проходит', async () => {
    const r = await handler({ action: 'set_price', query: 'гидролика дн200', price: 8500 });
    assert.equal(r.success, true);
    assert.equal(r.sku, 'GD-DN200');
  });

  test('латинская C находит артикул с кириллической С', async () => {
    const r = await handler({ action: 'set_discount_price', sku: '32023C', discount_price: 17100 });
    assert.equal(r.success, true);
    assert.equal(r.sku, '32023С');
    assert.equal(r.new_discount_price, 17100);
  });
});

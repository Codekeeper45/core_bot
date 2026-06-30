'use strict';
const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { normKey } = require('../../src/utils/stockKey');

// Мок mysql: in-memory склад.
const db = { rows: [], nextId: 1, reservations: [], nextReservationId: 1 };
const mysqlMock = {
  stockSearch: async (query, location, limit = 50) => {
    const toks = normKey(query).split(' ').filter(Boolean);
    return db.rows.filter((r) =>
      (!location || r.location === location)
      && toks.every((t) => r.norm_key.includes(t))).slice(0, limit);
  },
  stockList: async (location, limit = 50) => db.rows.filter((r) => !location || r.location === location).slice(0, limit),
  stockGetById: async (id) => db.rows.find((r) => r.id === Number(id)) || null,
  stockGetByKey: async (loc, key) => db.rows.find((r) => r.location === loc && r.norm_key === key) || null,
  stockUpsertSet: async (location, name, qty, unit = 'шт', by = null) => {
    const key = normKey(name);
    let row = db.rows.find((r) => r.location === location && r.norm_key === key);
    if (row) { row.qty = qty; row.name = name; row.unit = unit; }
    else { row = { id: db.nextId++, location, name, norm_key: key, qty, unit, updated_by: by }; db.rows.push(row); }
    return { id: row.id, created: true, qty: Number(row.qty) };
  },
  stockAdjust: async (row, delta, by = null) => {
    const live = db.rows.find((r) => r.id === row.id);
    const old = Number(live.qty); const next = old + Number(delta);
    if (next < 0) return { ok: false, reason: 'insufficient_available', available: old, reserved: 0 };
    live.qty = next; live.updated_by = by;
    return { ok: true, old, qty: next, available: next, reserved: 0 };
  },
  stockMovement: async (id, type, qty) => mysqlMock.stockAdjust(await mysqlMock.stockGetById(id), type === 'receive' ? qty : -qty),
  stockReserve: async (id, qty) => {
    const row = await mysqlMock.stockGetById(id);
    const reserved = db.reservations.filter((r) => r.stock_id === id && r.status === 'active').reduce((s, r) => s + r.qty, 0);
    if (qty > row.qty - reserved) return { ok: false, reason: 'insufficient_available', available: row.qty - reserved };
    const r = { id: db.nextReservationId++, stock_id: id, qty, status: 'active' }; db.reservations.push(r);
    return { ok: true, reservation_id: r.id, qty, available: row.qty - reserved - qty };
  },
  stockReleaseReservation: async () => ({ ok: true, status: 'released' }),
  stockListMovements: async () => [],
  stockRemove: async (id) => { const b = db.rows.length; db.rows = db.rows.filter((r) => r.id !== Number(id)); return b !== db.rows.length; },
  stockRename: async (id, newName) => { const r = db.rows.find((x) => x.id === Number(id)); if (r) { r.name = newName; r.norm_key = normKey(newName); } return !!r; },
};

const Module = require('module');
const orig = Module.prototype.require;
Module.prototype.require = function (id) {
  if (id === '../services/mysql') return mysqlMock;
  return orig.apply(this, arguments);
};
const { handler } = require('../../src/tools/manageStock');
Module.prototype.require = orig;

const seed = () => {
  db.rows = []; db.nextId = 1; db.reservations = []; db.nextReservationId = 1;
  mysqlMock.stockUpsertSet('Нижний', 'Лоток Аквасток ДН200Н310', 239);
  mysqlMock.stockUpsertSet('Нижний', 'Лоток Аквасток ДН100Н260', 68);
  mysqlMock.stockUpsertSet('Нижний', 'Лоток Гидролика ДН200Н230', 11);
};

describe('manage_stock', () => {
  beforeEach(seed);

  test('search находит по бренду+ДН', async () => {
    const r = await handler({ action: 'search', query: 'аквасток дн200' });
    assert.equal(r.success, true);
    assert.equal(r.count, 1);
    assert.equal(r.items[0].name, 'Лоток Аквасток ДН200Н310');
    assert.equal(r.items[0].qty, 239);
  });

  test('adjust: приход +50 увеличивает остаток', async () => {
    const r = await handler({ action: 'adjust', name: 'Лоток Аквасток ДН100Н260', delta: 50 });
    assert.equal(r.success, true);
    assert.equal(r.old, 68);
    assert.equal(r.qty, 118);
  });

  test('adjust: расход больше остатка отклоняется без изменения', async () => {
    const r = await handler({ action: 'adjust', name: 'Лоток Гидролика ДН200Н230', delta: -100 });
    assert.equal(r.success, false);
    assert.equal(r.reason, 'insufficient_available');
    const chk = await handler({ action: 'search', query: 'гидролика дн200' });
    assert.equal(chk.items[0].qty, 11);
  });

  test('adjust несуществующей позиции → not_found', async () => {
    const r = await handler({ action: 'adjust', name: 'Нет такого', delta: 5 });
    assert.equal(r.success, false);
    assert.equal(r.reason, 'not_found');
  });

  test('set создаёт/обновляет остаток', async () => {
    const r = await handler({ action: 'set', name: 'Лоток Аквасток ДН100Н260', qty: 5 });
    assert.equal(r.success, true);
    assert.equal(r.qty, 5);
    const chk = await handler({ action: 'search', query: 'аквасток дн100' });
    assert.equal(chk.items[0].qty, 5);
  });

  test('add дубликата → reason exists', async () => {
    const r = await handler({ action: 'add', name: 'Лоток Аквасток ДН200Н310', qty: 1 });
    assert.equal(r.success, false);
    assert.equal(r.reason, 'exists');
  });

  test('add новой позиции', async () => {
    const r = await handler({ action: 'add', name: 'Пескоуловитель ДН200', qty: 7 });
    assert.equal(r.success, true);
    assert.equal(r.qty, 7);
  });

  test('set с отрицательным qty → чистый invalid_qty, без выброса', async () => {
    const r = await handler({ action: 'set', name: 'Лоток Аквасток ДН100Н260', qty: -5 });
    assert.equal(r.success, false);
    assert.equal(r.reason, 'invalid_qty');
    const chk = await handler({ action: 'search', query: 'аквасток дн100' });
    assert.equal(chk.items[0].qty, 68);
  });

  test('add с отрицательным qty → чистый invalid_qty', async () => {
    const r = await handler({ action: 'add', name: 'Новая позиция XYZ', qty: -1 });
    assert.equal(r.success, false);
    assert.equal(r.reason, 'invalid_qty');
  });

  test('неоднозначность (несколько ДН200) → ambiguous, без мутации', async () => {
    const r = await handler({ action: 'adjust', name: 'дн200', delta: 10 });
    assert.equal(r.success, false);
    assert.equal(r.reason, 'ambiguous');
    assert.ok(r.candidates.length >= 2);
    // остатки не тронуты
    const a = await handler({ action: 'search', query: 'аквасток дн200' });
    assert.equal(a.items[0].qty, 239);
  });

  test('remove удаляет найденную позицию', async () => {
    const r = await handler({ action: 'remove', name: 'Лоток Аквасток ДН100Н260' });
    assert.equal(r.success, true);
    const chk = await handler({ action: 'search', query: 'аквасток дн100' });
    assert.equal(chk.count, 0);
  });

  test('reserve создаёт резерв и не меняет физический остаток', async () => {
    const r = await handler({ action: 'reserve', name: 'Лоток Аквасток ДН100Н260', qty: 20, object_ref: 'Объект А' });
    assert.equal(r.success, true);
    assert.equal(r.available, 48);
    const chk = await handler({ action: 'search', query: 'аквасток дн100' });
    assert.equal(chk.items[0].qty, 68);
  });
});

'use strict';
// Инструмент logistics с мок-mysql: lookup / calculate / trucks и подбор машины.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');

function normalizeSku(s) { return String(s || '').trim().toUpperCase().replace(/\s+/g, ''); }

// Позиции: артикул 11005 есть в двух источниках (palletirovka приоритетнее ves_plastik);
// 11000 — бетон; 080096 — без кол-ва на паллете. article_norm нужен для схлопывания.
const rows = [
  { source: 'palletirovka', article: '11005', article_norm: '11005', name: 'ЛВП Norma DN100 H55', series: 'NORMA', load_class: 'А,В,С', dn: 'DN100', length_mm: 1000, width_mm: 148, height_mm: 55, volume_m3: 0.00814, weight_kg: 1, qty_per_pallet: 169, pallet_weight_kg: 199, note: null },
  { source: 'ves_plastik', article: '11005', article_norm: '11005', name: 'Лоток ЛВП Norma DN100 H55', series: null, load_class: 'A,В,C', dn: 'DN100', length_mm: 1000, width_mm: 148, height_mm: 55, volume_m3: 0.00814, weight_kg: 1, qty_per_pallet: 169, pallet_weight_kg: null, note: null },
  { source: 'raspal_beton', article: '11000', article_norm: '11000', name: 'Лоток бетонный BGF', series: 'BGF 30', load_class: 'C250', dn: 'DN100', length_mm: 1000, width_mm: 160, height_mm: 80, volume_m3: 0.013, weight_kg: 19, qty_per_pallet: 49, pallet_weight_kg: null, note: null },
  { source: 'raspal_tde', article: '080096', article_norm: '080096', name: 'Комплект Gidrolica Light', series: null, load_class: 'A15', dn: 'DN100', length_mm: 1000, width_mm: 114.5, height_mm: 58, volume_m3: 0.007, weight_kg: 1.61, qty_per_pallet: null, pallet_weight_kg: null, note: 'согласно кол-ву в заказе' },
];

const trucks = [
  { name: 'Газель 9.0 м3', payload_t: 1.5, volume_m3: 9, inner_length_m: 3, inner_width_m: 1.7, inner_height_m: 1.7, pallet_places: 4 },
  { name: 'Foton, 30м3', payload_t: 4, volume_m3: 30, inner_length_m: 5.9, inner_width_m: 2.3, inner_height_m: 2.2, pallet_places: 10 },
  { name: '"Еврофура" 90 м3', payload_t: 20, volume_m3: 90, inner_length_m: 13.6, inner_width_m: 2.45, inner_height_m: 2.7, pallet_places: 33 },
];

const PRIORITY = ['palletirovka', 'raspal_tde', 'raspal_beton', 'raspal_yartsevo', 'ves_plastik'];

const mysqlMock = {
  logisticsGetByArticle: async (article) => rows
    .filter((x) => x.article_norm === normalizeSku(article))
    .sort((a, b) => PRIORITY.indexOf(a.source) - PRIORITY.indexOf(b.source)),
  logisticsSearch: async (query, limit = 6) => {
    const q = String(query).toLowerCase();
    return rows
      .filter((x) => x.article_norm === normalizeSku(query)
        || `${x.article} ${x.name} ${x.dn} ${x.load_class}`.toLowerCase().includes(q))
      .sort((a, b) => PRIORITY.indexOf(a.source) - PRIORITY.indexOf(b.source))
      .slice(0, limit);
  },
  listTrucks: async () => trucks.slice().sort((a, b) => a.payload_t - b.payload_t),
};

const orig = Module.prototype.require;
Module.prototype.require = function (id) {
  if (id === '../services/mysql') return mysqlMock;
  return orig.apply(this, arguments);
};
const { handler } = require('../../src/tools/logistics');
Module.prototype.require = orig;

test('trucks: возвращает справочник машин', async () => {
  const r = await handler({ action: 'trucks' });
  assert.equal(r.success, true);
  assert.equal(r.count, 3);
  assert.equal(r.trucks[0].name, 'Газель 9.0 м3');
});

test('lookup: артикул в двух источниках → приоритетный + other_sources', async () => {
  const r = await handler({ action: 'lookup', article: '11005' });
  assert.equal(r.success, true);
  assert.equal(r.item.source, 'palletirovka'); // самый полный
  assert.equal(r.item.pallet_weight_kg, 199);
  assert.equal(r.other_sources.length, 1);
  assert.equal(r.other_sources[0].source, 'ves_plastik');
});

test('lookup: неизвестный артикул → not_found', async () => {
  const r = await handler({ action: 'lookup', article: '999999' });
  assert.equal(r.success, false);
  assert.equal(r.reason, 'not_found');
});

test('lookup: неоднозначный запрос → ambiguous с кандидатами', async () => {
  const r = await handler({ action: 'lookup', query: 'DN100' });
  assert.equal(r.success, false);
  assert.equal(r.reason, 'ambiguous');
  assert.ok(r.candidates.length >= 2);
  // Один артикул из разных источников схлопнут в одного кандидата.
  const arts = r.candidates.map((c) => c.article);
  assert.equal(new Set(arts).size, arts.length);
});

test('calculate: суммирует вес/объём/паллеты и подбирает машину', async () => {
  const r = await handler({ action: 'calculate', items: [
    { article: '11005', qty: 338 }, // 2 паллеты (338/169), вес 338
    { article: '11000', qty: 49 },  // 1 паллета, вес 931
  ] });
  assert.equal(r.success, true);
  assert.equal(r.totals.pallets, 3);
  assert.equal(r.totals.goods_weight_kg, 338 + 931);
  assert.equal(r.totals.pallets_incomplete, false);
  // вес с паллетами = товар + 25*3
  assert.equal(r.totals.weight_with_pallets_kg, 1269 + 75);
  // Влезает в наименьшую подходящую: Газель (1.5т=1500кг ≥ 1344, 4 места ≥ 3, 9 м³ ≥ ~3.4).
  assert.equal(r.truck_recommendation.trucks_needed, 1);
  assert.equal(r.truck_recommendation.truck.name, 'Газель 9.0 м3');
});

test('calculate: позиция без кол-ва на паллете → флаг pallets_incomplete', async () => {
  const r = await handler({ action: 'calculate', items: [{ article: '080096', qty: 100 }] });
  assert.equal(r.success, true);
  assert.equal(r.totals.pallets_incomplete, true);
  assert.equal(r.lines[0].pallets, null);
  assert.ok(/неполн/i.test(r.note));
});

test('calculate: заказ больше самой большой машины → сколько нужно', async () => {
  const r = await handler({ action: 'calculate', items: [{ article: '11000', qty: 5000 }] });
  // 5000*19 = 95000 кг товара; паллет 5000/49=103; с паллетами 95000+25*103.
  assert.equal(r.success, true);
  assert.equal(r.truck_recommendation.exceeds_single, true);
  assert.ok(r.truck_recommendation.trucks_needed > 1);
  assert.equal(r.truck_recommendation.truck.name, '"Еврофура" 90 м3');
});

test('calculate: пустой список → empty_items', async () => {
  const r = await handler({ action: 'calculate', items: [] });
  assert.equal(r.success, false);
  assert.equal(r.reason, 'empty_items');
});

'use strict';
// Парсер логистической/паллетировочной базы на реальных файлах из корня репо.
// Проверяет per-source раскладку колонок, guard позиций и трак-справочник.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { parseAllLogistics, parseDimsString } = require('../../src/services/logistics');

const ROOT = path.join(__dirname, '..', '..');

function pick(items, source, article) {
  return items.find((x) => x.source === source && x.article === String(article));
}

test('parseAllLogistics: позиции из всех источников + машины', () => {
  const { items, trucks } = parseAllLogistics(ROOT);

  const bySource = items.reduce((acc, it) => { acc[it.source] = (acc[it.source] || 0) + 1; return acc; }, {});
  for (const src of ['ves_plastik', 'raspal_tde', 'raspal_beton', 'raspal_yartsevo', 'palletirovka']) {
    assert.ok(bySource[src] > 0, `должны быть позиции из источника ${src}`);
  }
  assert.ok(items.length > 2000, 'суммарно позиций должно быть много (>2000)');
  // Все позиции проходят guard: артикул + имя + положительный вес.
  assert.ok(items.every((x) => x.article && x.name && x.weight_kg > 0));

  // Справочник машин: 11 машин, Еврофура — 20 т, 33 паллето-места.
  assert.equal(trucks.length, 11);
  const euro = trucks.find((t) => /еврофура/i.test(t.name));
  assert.ok(euro, 'Еврофура должна быть в справочнике');
  assert.equal(euro.payload_t, 20);
  assert.equal(euro.pallet_places, 33);
  assert.equal(euro.volume_m3, 90);
  // Легенда («тоннаж/европалет/…») отсеяна — payload у всех числовой.
  assert.ok(trucks.every((t) => typeof t.payload_t === 'number'));
});

test('спот-чеки позиций по источникам', () => {
  const { items } = parseAllLogistics(ROOT);

  const ves = pick(items, 'ves_plastik', 11005);
  assert.ok(ves);
  assert.equal(ves.weight_kg, 1);
  assert.equal(ves.qty_per_pallet, 169);
  assert.equal(ves.length_mm, 1000); // габариты из строки "1000 х 148 х 55"
  assert.equal(ves.width_mm, 148);
  assert.equal(ves.height_mm, 55);
  assert.equal(ves.dn, 'DN100'); // DN извлечён из названия

  // Бетон БГ: вес в кол.8, объём в кол.9 (у ТДЕ наоборот — карта колонок разная).
  const beton = pick(items, 'raspal_beton', 11000);
  assert.ok(beton);
  assert.equal(beton.weight_kg, 19);
  assert.equal(beton.volume_m3, 0.013);
  assert.equal(beton.qty_per_pallet, 49);
  assert.equal(beton.series, 'BGF 30');

  // Ярцево: без колонки объёма — вычисляется из габаритов.
  const yar = pick(items, 'raspal_yartsevo', 130240);
  assert.ok(yar);
  assert.equal(yar.weight_kg, 164);
  assert.equal(yar.qty_per_pallet, 6);
  assert.ok(yar.volume_m3 > 0, 'объём вычислен из габаритов');

  // Паллетировка: вес всей паллеты присутствует.
  const pal = pick(items, 'palletirovka', 11005);
  assert.ok(pal);
  assert.equal(pal.pallet_weight_kg, 199);
  assert.equal(pal.series, 'NORMA');

  // ТДЕ Gidrolica: qty_per_pallet может быть null («согласно кол-ву в заказе»).
  const tde = pick(items, 'raspal_tde', '080096');
  assert.ok(tde);
  assert.equal(tde.weight_kg, 1.61);
  assert.equal(tde.qty_per_pallet, null);
});

test('parseDimsString разбирает габариты одной строкой', () => {
  assert.deepEqual(parseDimsString('1000 х 148 х 55'), { length_mm: 1000, width_mm: 148, height_mm: 55 });
  assert.deepEqual(parseDimsString('1000x148x55'), { length_mm: 1000, width_mm: 148, height_mm: 55 });
  assert.deepEqual(parseDimsString(''), { length_mm: null, width_mm: null, height_mm: null });
});

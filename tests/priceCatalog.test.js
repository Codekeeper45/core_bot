'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

test('парсер прайса Аквасток извлекает Norma с ТТ, розницу и скидочную цену', () => {
  const { parsePriceWorkbook } = require('../src/services/priceCatalog');
  const root = path.join(__dirname, '..');
  const file = fs.readdirSync(root).find((name) => /аквасток.*январь.*2026.*продажн.*\.xlsx$/iu.test(name.normalize('NFC')));
  assert.ok(file, 'прайс XLSX должен находиться в корне репозитория');
  const parsed = parsePriceWorkbook(path.join(root, file));
  assert.equal(parsed.items.length, 85);
  assert.equal(new Set(parsed.items.map((x) => x.sku)).size, 85);
  assert.equal(parsed.sheet, 'Norma с ТТ');
  assert.equal(parsed.price_date, '2026-01-01');

  const item = parsed.items.find((x) => x.sku === '11005');
  assert.equal(item.name, 'Лоток водоотводный пластиковый ЛВП Norma DN100 H55');
  assert.equal(item.retail_price, 3600);
  assert.equal(item.discount_price, 3060);
  assert.equal(item.dn, 'DN100');
  assert.equal(item.load_class, 'А, В, С');
  assert.equal(item.length_mm, 1000);
  assert.equal(item.width_mm, 148);
  assert.equal(item.height_mm, 55);
  assert.equal(item.weight_kg, 1);
  assert.equal(item.pallet_qty, '169');

  const novelty = parsed.items.find((x) => x.sku === 'AQ-NOVINKA-R031');
  assert.equal(novelty.source_sku, 'новинка');
  assert.equal(novelty.name, 'Решетка пластиковая косичка РПК Norma DN100');
});

test('парсер видит проблемные артикулы из повторного тестирования', () => {
  const { parsePriceWorkbook } = require('../src/services/priceCatalog');
  const root = path.join(__dirname, '..');
  const file = fs.readdirSync(root).find((name) => /аквасток.*январь.*2026.*продажн.*\.xlsx$/iu.test(name.normalize('NFC')));
  const parsed = parsePriceWorkbook(path.join(root, file));
  const skus = new Set(parsed.items.map((x) => x.sku));
  for (const sku of ['11005', '11007', '11012', '11015', '11018', '11042', '9270', '9212', '91102V', '911011', '31013B', '31513С', '32023С', '4300', '4330']) {
    assert.ok(skus.has(sku), `нет артикула ${sku}`);
  }
});

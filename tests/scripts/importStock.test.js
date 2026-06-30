'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { parseStockRows } = require('../../scripts/importStock');

describe('parseStockRows (импорт остатков из xlsx)', () => {
  // Имитируем структуру листа: 2 строки шапки, имя в кол.0, остаток в кол.28.
  const headers = [
    ['Наименование', 'Дата прихода', /* ... */],
    ['', 46156, /* ... */],
  ];
  const row = (name, rem) => { const r = new Array(29).fill(''); r[0] = name; r[28] = rem; return r; };

  test('берёт имя (0) и остаток (28), пропускает пустые имена и нечисловые', () => {
    const rows = [
      ...headers,
      row('Лоток Аквасток ДН100Н260', 68),
      row('', ''),                       // пустой разделитель → пропуск
      row('Лоток Аквасток ДН150Н175', 80),
      row('Чугунная решётка', 'н/д'),    // нечисловой остаток → пропуск
      row('Лоток с нулём', 0),           // 0 — валидный остаток
    ];
    const items = parseStockRows(rows);
    assert.deepEqual(items, [
      { name: 'Лоток Аквасток ДН100Н260', qty: 68 },
      { name: 'Лоток Аквасток ДН150Н175', qty: 80 },
      { name: 'Лоток с нулём', qty: 0 },
    ]);
  });

  test('тримит имя и уважает headerRows', () => {
    const rows = [['шапка'], row('  Позиция X  ', 5)];
    const items = parseStockRows(rows, { headerRows: 1 });
    assert.deepEqual(items, [{ name: 'Позиция X', qty: 5 }]);
  });
});

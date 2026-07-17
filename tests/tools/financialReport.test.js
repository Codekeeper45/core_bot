'use strict';
// financial_analysis: источник (бинарник/текст) + маппинг → доходы/расходы/баланс.
const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');
const XLSX = require('xlsx');

let binEntry = null;  // { fileName, buffer }
let textEntry = null; // { fileName, text }

const binStashMock = { get: () => binEntry };
const docStashMock = { get: () => textEntry };

const originalRequire = Module.prototype.require;
Module.prototype.require = function (id) {
  if (id === '../services/docBinaryStash') return binStashMock;
  if (id === '../services/docStash') return docStashMock;
  return originalRequire.apply(this, arguments);
};
delete require.cache[require.resolve('../../src/tools/financialReport')];
const { handler } = require('../../src/tools/financialReport');
Module.prototype.require = originalRequire;

function xlsxBuf(aoa) {
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Обороты');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

const ctx = { channel: 'whatsapp', chatId: '7700' };

describe('financial_analysis', () => {
  beforeEach(() => { binEntry = null; textEntry = null; });

  test('успех: бинарник Excel + маппинг двух колонок', async () => {
    binEntry = { fileName: 'обороты.xlsx', buffer: xlsxBuf([
      ['Дата', 'Кредит', 'Дебет'],
      ['2026-06-01', '1 000 000', ''],
      ['2026-06-15', '', '400 000'],
    ]) };
    const r = await handler({ file: 'last', mapping: { income_col: 'Кредит', expense_col: 'Дебет', date_col: 'Дата' } }, ctx);
    assert.equal(r.success, true);
    assert.equal(r.source, 'обороты.xlsx');
    assert.equal(r.income, 1000000);
    assert.equal(r.expense, 400000);
    assert.equal(r.balance, 600000);
    assert.equal(r.by_month[0].month, '2026-06');
    assert.equal(r.column_totals['Кредит'], 1000000);
  });

  test('нет mapping → no_mapping', async () => {
    binEntry = { fileName: 'x.xlsx', buffer: xlsxBuf([['A'], ['1']]) };
    const r = await handler({ file: 'last' }, ctx);
    assert.equal(r.success, false);
    assert.equal(r.reason, 'no_mapping');
  });

  test('файла нет ни в бинарнике, ни в тексте → not_in_stash', async () => {
    const r = await handler({ mapping: { income_col: 'A', expense_col: 'B' } }, ctx);
    assert.equal(r.success, false);
    assert.equal(r.reason, 'not_in_stash');
  });

  test('плохой маппинг → bad_mapping с колонками', async () => {
    binEntry = { fileName: 'x.xlsx', buffer: xlsxBuf([['Дата', 'Сумма'], ['2026-06-01', '100']]) };
    const r = await handler({ mapping: { foo: 'bar' } }, ctx);
    assert.equal(r.success, false);
    assert.equal(r.reason, 'bad_mapping');
    assert.deepEqual(r.columns, ['Дата', 'Сумма']);
  });

  test('фолбэк на текст (CSV) когда бинарника нет', async () => {
    textEntry = { fileName: 'обороты.csv', text: 'Дата;Кредит;Дебет\n2026-06-01;500;0\n2026-06-02;0;120\n' };
    const r = await handler({ mapping: { income_col: 'Кредит', expense_col: 'Дебет' } }, ctx);
    assert.equal(r.success, true);
    assert.equal(r.income, 500);
    assert.equal(r.expense, 120);
  });
});

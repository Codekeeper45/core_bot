'use strict';
// financeAnalyzer: детерминированный разбор выгрузки (1С/Excel/CSV) — три режима маппинга.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const XLSX = require('xlsx');
const { analyzeFinance, _internals } = require('../../src/services/financeAnalyzer');

function xlsxBuf(aoa, sheetName = 'Обороты') {
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, sheetName);
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

describe('financeAnalyzer.parseNum', () => {
  test('форматы 1С: пробелы, запятая, скобки', () => {
    assert.equal(_internals.parseNum('1 200 000'), 1200000);
    assert.equal(_internals.parseNum('1000,50'), 1000.5);
    assert.equal(_internals.parseNum('(1 234)'), -1234);
    assert.equal(_internals.parseNum('1.234,56'), 1234.56);
    assert.equal(_internals.parseNum(''), null);
    assert.equal(_internals.parseNum('—'), null);
    assert.equal(_internals.parseNum(2500), 2500);
  });
});

describe('financeAnalyzer.analyzeFinance', () => {
  test('режим 1: две колонки (Кредит/Дебет) + помесячно', () => {
    const buf = xlsxBuf([
      ['Дата', 'Операция', 'Кредит', 'Дебет'],
      ['2026-06-03', 'Оплата', '1 200 000', ''],
      ['2026-06-10', 'Аренда', '', '300 000'],
      ['2026-07-05', 'Оплата', '800 000', ''],
      ['2026-07-20', 'Зарплата', '', '500 000'],
    ]);
    const r = analyzeFinance({ buffer: buf }, { income_col: 'Кредит', expense_col: 'Дебет', date_col: 'Дата' });
    assert.equal(r.mode, 'two_columns');
    assert.equal(r.income, 2000000);
    assert.equal(r.expense, 800000);
    assert.equal(r.balance, 1200000);
    assert.equal(r.by_month.length, 2);
    assert.deepEqual(r.by_month[0], { month: '2026-06', income: 1200000, expense: 300000, balance: 900000, rows: 2 });
    assert.equal(r.column_totals['Кредит'], 2000000);
    assert.equal(r.column_totals['Дебет'], 800000);
  });

  test('режим 2: сумма + тип операции (слова-признаки)', () => {
    const buf = xlsxBuf([
      ['Дата', 'Тип', 'Сумма'],
      ['01.06.2026', 'Приход', '1000,50'],
      ['02.06.2026', 'Расход', '400,25'],
      ['03.06.2026', 'приход', '250'],
      ['04.06.2026', 'Корректировка', '999'],
    ]);
    const r = analyzeFinance({ buffer: buf }, {
      amount_col: 'Сумма', type_col: 'Тип', income_when: ['приход'], expense_when: ['расход'], date_col: 'Дата',
    });
    assert.equal(r.mode, 'typed');
    assert.equal(r.income, 1250.5);
    assert.equal(r.expense, 400.25);
    assert.equal(r.rows_skipped, 1, 'строка с неизвестным типом пропущена');
  });

  test('режим 3: сумма со знаком, колонка по букве', () => {
    const buf = xlsxBuf([
      ['Дата', 'Движение'],
      ['2026-06-01', 5000],
      ['2026-06-02', -1500],
      ['2026-06-03', -500],
    ]);
    const r = analyzeFinance({ buffer: buf }, { amount_col: 'B', sign_rule: 'positive_income' });
    assert.equal(r.mode, 'signed');
    assert.equal(r.income, 5000);
    assert.equal(r.expense, 2000);
    assert.equal(r.balance, 3000);
  });

  test('плохой маппинг → error с перечнем колонок', () => {
    const buf = xlsxBuf([['Дата', 'Движение'], ['2026-06-01', 1]]);
    const r = analyzeFinance({ buffer: buf }, { foo: 'bar' });
    assert.equal(r.error, 'bad_mapping');
    assert.deepEqual(r.columns, ['Дата', 'Движение']);
  });

  test('CSV-текст (разделитель 1С)', () => {
    const csv = 'Дата;Кредит;Дебет\n2026-06-01;1000;0\n2026-06-02;0;250\n';
    const r = analyzeFinance({ text: csv }, { income_col: 'Кредит', expense_col: 'Дебет' });
    assert.equal(r.income, 1000);
    assert.equal(r.expense, 250);
    assert.equal(r.balance, 750);
  });

  test('header_row: шапка не в первой строке', () => {
    const buf = xlsxBuf([
      ['Отчёт за июнь', '', ''],
      ['Дата', 'Кредит', 'Дебет'],
      ['2026-06-01', '500', '200'],
    ]);
    const r = analyzeFinance({ buffer: buf }, { income_col: 'Кредит', expense_col: 'Дебет', header_row: 2 });
    assert.equal(r.income, 500);
    assert.equal(r.expense, 200);
  });
});

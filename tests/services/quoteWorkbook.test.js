'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const XLSX = require('xlsx');
const JSZip = require('jszip');
const { renderQuote, TEMPLATE_PATH } = require('../../src/services/quoteWorkbook');

const baseQuote = {
  quote_number: '7-2607',
  recipient: 'ТОО Тестовый заказчик',
  offer_date: '09.07.2026',
  terms: ['Оплата: предоплата 100%.', 'Доставка до объекта заказчика.', 'Предложение действительно 5 дней.'],
};

function line(index) {
  return {
    sku: `AQ-${index}`,
    supplier_label: 'Аквасток / Norma (январь 2026)',
    name: `Лоток тестовый DN${100 + index}`,
    length_mm: 1000,
    width_mm: 148,
    dn: `DN${100 + index}`,
    height_mm: 55,
    qty: index,
    unit_price: 3000 + index,
    line_total: index * (3000 + index),
  };
}

test('renderQuote заполняет шаблон, сдвигает итог и сохраняет изображения', async () => {
  const lines = [line(1), line(2), line(3), line(4)];
  const total = lines.reduce((sum, item) => sum + item.line_total, 0);
  const buffer = await renderQuote({ ...baseQuote, lines, total });
  assert.ok(buffer.length > 100000);

  const workbook = XLSX.read(buffer, { type: 'buffer', cellFormula: true });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  assert.match(String(sheet.B8.v), /Исходящий №7-2607/);
  assert.match(String(sheet.B11.v), /Тестовый заказчик/);
  assert.match(String(sheet.B13.v), /Лоток тестовый DN101/);
  assert.match(String(sheet.B16.v), /Лоток тестовый DN104/);
  assert.equal(sheet.J17.v, total);
  assert.equal(sheet.J17.f, 'SUM(J13:J16)');
  assert.equal(sheet.B18.v, baseQuote.terms[0]);

  const zip = await JSZip.loadAsync(buffer);
  assert.ok(zip.file('xl/media/image1.png'));
  assert.ok(zip.file('xl/media/image2.png'));
  assert.equal(await zip.file('xl/calcChain.xml'), null);
  assert.doesNotMatch(await zip.file('xl/sharedStrings.xml').async('string'), /Gidrolica/i);
  assert.match(await zip.file('xl/worksheets/sheet1.xml').async('string'), /H17:I17/);
});

test('renderQuote создаёт корректное КП и для одной позиции', async () => {
  const lines = [line(1)];
  const buffer = await renderQuote({ ...baseQuote, lines, total: lines[0].line_total });
  const workbook = XLSX.read(buffer, { type: 'buffer', cellFormula: true });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  assert.equal(sheet.J14.v, lines[0].line_total);
  assert.equal(sheet.J14.f, 'SUM(J13:J13)');
  assert.match(String(sheet.B15.v), /Оплата/);
});

test('шаблон КП хранится в отслеживаемом ресурсе', () => {
  assert.match(TEMPLATE_PATH, /src[\\/]templates[\\/]neodrain-quote\.xlsx$/);
});

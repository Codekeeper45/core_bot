'use strict';
// docxBuilder: сборка нового .docx из структуры и хирургическая правка присланного.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const JSZip = require('jszip');
const { buildDocx, editDocx } = require('../../src/services/docxBuilder');

async function docXml(buffer) {
  const zip = await JSZip.loadAsync(buffer);
  return zip.file('word/document.xml').async('string');
}

describe('docxBuilder.buildDocx', () => {
  test('собирает валидный zip с заголовком, абзацем и таблицей', async () => {
    const buffer = await buildDocx({
      title: 'ДОГОВОР ПОСТАВКИ',
      blocks: [
        { type: 'heading', level: 1, text: '1. Предмет' },
        { type: 'paragraph', text: 'Сумма 1 000 000 тенге.' },
        { type: 'table', header: true, rows: [['Товар', 'Кол-во'], ['Лоток', '10']] },
      ],
    });
    assert.ok(Buffer.isBuffer(buffer) && buffer.length > 0);
    const zip = await JSZip.loadAsync(buffer);
    assert.ok(zip.file('[Content_Types].xml'), 'есть content types');
    assert.ok(zip.file('_rels/.rels'), 'есть rels');
    const xml = await docXml(buffer);
    assert.match(xml, /ДОГОВОР ПОСТАВКИ/);
    assert.match(xml, /1\. Предмет/);
    assert.match(xml, /<w:tbl>/);
    assert.match(xml, /1 000 000/);
  });

  test('экранирует спецсимволы XML', async () => {
    const xml = await docXml(await buildDocx({ blocks: [{ type: 'paragraph', text: 'A & B < C > "D"' }] }));
    assert.match(xml, /A &amp; B &lt; C &gt;/);
    assert.doesNotMatch(xml, /A & B/);
  });

  test('пустой spec не даёт пустое тело (валидный документ)', async () => {
    const xml = await docXml(await buildDocx({}));
    assert.match(xml, /<w:body>/);
    assert.match(xml, /<w:sectPr>/);
  });
});

describe('docxBuilder.editDocx', () => {
  async function sample() {
    return buildDocx({
      blocks: [
        { type: 'paragraph', text: 'Поставщик обязуется поставить товар на 1 000 000 тенге.' },
        { type: 'table', header: true, rows: [['Товар', 'Цена'], ['Лоток', '3600']] },
      ],
    });
  }

  test('заменяет текст, сохраняя таблицу; сообщает hits', async () => {
    const res = await editDocx(await sample(), [
      { find: '1 000 000', replace: '2 500 000' },
      { find: 'Поставщик', replace: 'Продавец' },
    ]);
    assert.equal(res.changed, true);
    assert.equal(res.hits['1 000 000'], 1);
    assert.equal(res.hits['Поставщик'], 1);
    assert.deepEqual(res.notFound, []);
    const xml = await docXml(res.buffer);
    assert.match(xml, /2 500 000/);
    assert.match(xml, /Продавец/);
    assert.doesNotMatch(xml, /1 000 000/);
    assert.match(xml, /<w:tbl>/, 'таблица цела');
  });

  test('замена внутри ячейки таблицы работает', async () => {
    const res = await editDocx(await sample(), [{ find: '3600', replace: '4200' }]);
    assert.equal(res.changed, true);
    assert.match(await docXml(res.buffer), /4200/);
  });

  test('нет совпадения → changed=false, reason=no_match, notFound', async () => {
    const res = await editDocx(await sample(), [{ find: 'ОТСУТСТВУЕТ', replace: 'x' }]);
    assert.equal(res.changed, false);
    assert.equal(res.reason, 'no_match');
    assert.deepEqual(res.notFound, ['ОТСУТСТВУЕТ']);
    assert.equal(res.buffer, null);
  });

  test('пустой список правок → no_edits', async () => {
    const res = await editDocx(await sample(), []);
    assert.equal(res.reason, 'no_edits');
  });

  test('не Word (zip без word/document.xml) → not_word', async () => {
    const z = new JSZip();
    z.file('xl/workbook.xml', '<x/>');
    const res = await editDocx(await z.generateAsync({ type: 'nodebuffer' }), [{ find: 'a', replace: 'b' }]);
    assert.equal(res.reason, 'not_word');
  });

  test('не zip (легаси .doc) → not_zip', async () => {
    const res = await editDocx(Buffer.from('\xD0\xCF\x11\xE0 legacy doc'), [{ find: 'a', replace: 'b' }]);
    assert.equal(res.reason, 'not_zip');
  });
});

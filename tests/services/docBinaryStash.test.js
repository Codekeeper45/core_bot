'use strict';
// docBinaryStash: in-memory буфер ОРИГИНАЛЬНЫХ .docx/.xlsx для manage_document/financial_analysis.
const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const stash = require('../../src/services/docBinaryStash');
const config = require('../../src/config');

const buf = (s) => Buffer.from(s, 'utf-8');

describe('docBinaryStash', () => {
  beforeEach(() => stash._clear());

  test('put/get: по имени (регистронезависимо) и по last', () => {
    stash.put('whatsapp', '111', { fileName: 'договор.docx', buffer: buf('A'), mimetype: 'application/x' });
    stash.put('whatsapp', '111', { fileName: 'выгрузка.xlsx', buffer: buf('B') });
    assert.equal(stash.get('whatsapp', '111', 'договор.docx').buffer.toString(), 'A');
    assert.equal(stash.get('whatsapp', '111', 'ДОГОВОР.DOCX').buffer.toString(), 'A');
    assert.equal(stash.get('whatsapp', '111', 'last').fileName, 'выгрузка.xlsx');
    assert.equal(stash.get('whatsapp', '111', '').fileName, 'выгрузка.xlsx');
    assert.equal(stash.get('whatsapp', '111', 'договор.docx').mimetype, 'application/x');
  });

  test('изоляция по каналу и чату', () => {
    stash.put('whatsapp', '111', { fileName: 'a.docx', buffer: buf('a') });
    assert.equal(stash.get('telegram', '111', 'last'), null);
    assert.equal(stash.get('whatsapp', '222', 'last'), null);
  });

  test('повторная отправка того же файла заменяет запись', () => {
    stash.put('whatsapp', '111', { fileName: 'a.docx', buffer: buf('v1') });
    stash.put('whatsapp', '111', { fileName: 'a.docx', buffer: buf('v2') });
    assert.equal(stash.list('whatsapp', '111').length, 1);
    assert.equal(stash.get('whatsapp', '111', 'a.docx').buffer.toString(), 'v2');
  });

  test('вытеснение сверх DOC_BINARY_STASH_MAX (старые уходят первыми)', () => {
    for (let i = 0; i < config.DOC_BINARY_STASH_MAX + 2; i++) {
      stash.put('whatsapp', '111', { fileName: `f${i}.docx`, buffer: buf(`t${i}`) });
    }
    const names = stash.list('whatsapp', '111').map((x) => x.fileName);
    assert.equal(names.length, config.DOC_BINARY_STASH_MAX);
    assert.ok(!names.includes('f0.docx'));
    assert.ok(names.includes(`f${config.DOC_BINARY_STASH_MAX + 1}.docx`));
  });

  test('TTL: просроченные записи вычищаются', () => {
    stash.put('whatsapp', '111', { fileName: 'old.docx', buffer: buf('x') });
    const entry = stash.get('whatsapp', '111', 'old.docx');
    entry.ts = Date.now() - config.DOC_BINARY_STASH_TTL_MS - 1000;
    assert.equal(stash.get('whatsapp', '111', 'old.docx'), null);
    assert.equal(stash.list('whatsapp', '111').length, 0);
  });

  test('невалидные аргументы игнорируются (нет буфера / не Buffer)', () => {
    stash.put('whatsapp', '111', { fileName: 'a.docx', buffer: null });
    stash.put('whatsapp', '111', { fileName: '', buffer: buf('x') });
    stash.put('whatsapp', '111', { fileName: 'b.docx', buffer: 'не буфер' });
    assert.equal(stash.list('whatsapp', '111').length, 0);
  });
});

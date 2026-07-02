'use strict';
// docStash: in-memory буфер распарсенных документов для manage_files save.
const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const docStash = require('../../src/services/docStash');
const config = require('../../src/config');

describe('docStash', () => {
  beforeEach(() => docStash._clear());

  test('put/get: по имени и по last', () => {
    docStash.put('whatsapp', '111', { fileName: 'договор.pdf', text: 'текст договора' });
    docStash.put('whatsapp', '111', { fileName: 'прайс.xlsx', text: 'текст прайса' });
    assert.equal(docStash.get('whatsapp', '111', 'договор.pdf').text, 'текст договора');
    assert.equal(docStash.get('whatsapp', '111', 'ДОГОВОР.PDF').text, 'текст договора', 'имя регистронезависимо');
    assert.equal(docStash.get('whatsapp', '111', 'last').fileName, 'прайс.xlsx');
    assert.equal(docStash.get('whatsapp', '111', '').fileName, 'прайс.xlsx');
  });

  test('изоляция по каналу и чату', () => {
    docStash.put('whatsapp', '111', { fileName: 'a.txt', text: 'a' });
    assert.equal(docStash.get('telegram', '111', 'last'), null);
    assert.equal(docStash.get('whatsapp', '222', 'last'), null);
  });

  test('повторная отправка того же файла заменяет запись', () => {
    docStash.put('whatsapp', '111', { fileName: 'a.txt', text: 'v1' });
    docStash.put('whatsapp', '111', { fileName: 'a.txt', text: 'v2' });
    assert.equal(docStash.list('whatsapp', '111').length, 1);
    assert.equal(docStash.get('whatsapp', '111', 'a.txt').text, 'v2');
  });

  test('вытеснение сверх DOC_STASH_MAX (старые уходят первыми)', () => {
    for (let i = 0; i < config.DOC_STASH_MAX + 2; i++) {
      docStash.put('whatsapp', '111', { fileName: `f${i}.txt`, text: `t${i}` });
    }
    const names = docStash.list('whatsapp', '111').map((x) => x.fileName);
    assert.equal(names.length, config.DOC_STASH_MAX);
    assert.ok(!names.includes('f0.txt'));
    assert.ok(names.includes(`f${config.DOC_STASH_MAX + 1}.txt`));
  });

  test('TTL: просроченные записи вычищаются', () => {
    docStash.put('whatsapp', '111', { fileName: 'old.txt', text: 'x' });
    // Прямо состарим запись через приватное состояние невозможно — эмулируем через ts.
    const entry = docStash.get('whatsapp', '111', 'old.txt');
    entry.ts = Date.now() - config.DOC_STASH_TTL_MS - 1000;
    assert.equal(docStash.get('whatsapp', '111', 'old.txt'), null);
    assert.equal(docStash.list('whatsapp', '111').length, 0);
  });

  test('пустые аргументы игнорируются', () => {
    docStash.put('whatsapp', '111', { fileName: '', text: 'x' });
    docStash.put('whatsapp', '111', { fileName: 'a', text: '' });
    assert.equal(docStash.list('whatsapp', '111').length, 0);
  });
});

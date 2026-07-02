'use strict';
// search_files: фрагменты с именем файла-источника, права через role/channel/chatId.
const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');

let lastArgs = null;
let impl = async () => ({ ok: true, mode: 'semantic', results: [] });
const fileKnowledgeMock = {
  searchFiles: async (args) => { lastArgs = args; return impl(args); },
};

const orig = Module.prototype.require;
Module.prototype.require = function (id) {
  if (id === '../services/fileKnowledge') return fileKnowledgeMock;
  return orig.apply(this, arguments);
};
const { handler } = require('../../src/tools/searchFiles');
Module.prototype.require = orig;

describe('search_files', () => {
  beforeEach(() => { lastArgs = null; impl = async () => ({ ok: true, mode: 'semantic', results: [] }); });

  test('пустой query → отказ без поиска', async () => {
    const r = await handler({ query: '  ' }, { channel: 'whatsapp', chatId: '1' });
    assert.equal(r.success, false);
    assert.equal(r.reason, 'empty_query');
    assert.equal(lastArgs, null);
  });

  test('context (role/channel/chatId) пробрасывается для фильтра видимости', async () => {
    await handler({ query: 'цена лотка', file_name: 'прайс.xlsx', limit: 3 },
      { channel: 'whatsapp', chatId: 'emp1', role: 'employee' });
    assert.equal(lastArgs.channel, 'whatsapp');
    assert.equal(lastArgs.chatId, 'emp1');
    assert.equal(lastArgs.role, 'employee');
    assert.equal(lastArgs.fileName, 'прайс.xlsx');
    assert.equal(lastArgs.limit, 3);
  });

  test('фрагменты несут имя файла-источника + note про цитирование', async () => {
    impl = async () => ({
      ok: true,
      mode: 'semantic',
      results: [
        { score: 0.91234, file_id: 1, file_name: 'договор.pdf', owner_name: 'Али', visibility: 'public', seq: 2, content: 'пункт 4.2: оплата в течение 10 дней' },
      ],
    });
    const r = await handler({ query: 'сроки оплаты' }, { channel: 'whatsapp', chatId: '1', role: 'employee' });
    assert.equal(r.success, true);
    assert.equal(r.found, 1);
    assert.equal(r.fragments[0].file_name, 'договор.pdf');
    assert.equal(r.fragments[0].chunk, 2);
    assert.equal(r.fragments[0].score, 0.912);
    assert.match(r.note, /файл-источник/);
  });

  test('keyword-режим (эмбеддинги выключены) отдаётся как mode=keyword', async () => {
    impl = async () => ({ ok: true, mode: 'keyword', results: [{ score: null, file_id: 1, file_name: 'a.txt', owner_name: null, visibility: 'public', seq: 1, content: 'x' }] });
    const r = await handler({ query: 'x' }, { channel: 'whatsapp', chatId: '1' });
    assert.equal(r.mode, 'keyword');
    assert.equal(r.fragments[0].score, null);
  });

  test('ничего не найдено → подсказка про manage_files list', async () => {
    const r = await handler({ query: 'несуществующее' }, { channel: 'whatsapp', chatId: '1' });
    assert.equal(r.found, 0);
    assert.match(r.note, /manage_files list/);
  });
});

'use strict';
const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');

// Мок mysql loadHistory/saveHistory (память хранит истории в объекте).
const store = { rows: {} };
const k = (c, id) => `${c}|${id}`;
const mysqlMock = {
  loadHistory: async (c, id) => store.rows[k(c, id)] || { summary: '', messages: [] },
  saveHistory: async (c, id, messages, summary) => { store.rows[k(c, id)] = { summary: summary || '', messages }; },
  archiveMessage: async () => {},
};

const Module = require('module');
const orig = Module.prototype.require;
Module.prototype.require = function (id) {
  if (id === '../services/mysql') return mysqlMock;
  return orig.apply(this, arguments);
};
const memory = require('../src/agent/memory');
after(() => { Module.prototype.require = orig; });

describe('recordOutbound — запись исходящего в историю получателя', () => {
  test('добавляет assistant-ход под тем же ключом, сводку сохраняет', async () => {
    store.rows = {};
    store.rows[k('whatsapp', '7707@s.whatsapp.net')] = { summary: 's', messages: [{ role: 'user', content: 'до' }] };
    await memory.recordOutbound('whatsapp', '7707@s.whatsapp.net', 'Задача #5: собрать лотки');
    const h = store.rows[k('whatsapp', '7707@s.whatsapp.net')];
    assert.equal(h.messages.length, 2);
    assert.deepEqual(h.messages[1], { role: 'assistant', content: 'Задача #5: собрать лотки' });
    assert.equal(h.summary, 's');
  });

  test('создаёт историю с нуля, если её не было', async () => {
    store.rows = {};
    await memory.recordOutbound('telegram', '123', 'Напоминание про документы');
    assert.equal(store.rows[k('telegram', '123')].messages.length, 1);
    assert.equal(store.rows[k('telegram', '123')].messages[0].role, 'assistant');
  });

  test('пустой текст или ключ — no-op (ничего не пишем)', async () => {
    store.rows = {};
    await memory.recordOutbound('telegram', '123', '');
    await memory.recordOutbound('telegram', '', 'x');
    await memory.recordOutbound('', '123', 'x');
    assert.equal(Object.keys(store.rows).length, 0);
  });
});

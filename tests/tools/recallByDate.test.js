'use strict';
const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');

let lastArgs = null;
const mysqlMock = {
  archiveByDateRange: async (params) => {
    lastArgs = params;
    return [
      { id: 1, channel: 'whatsapp', chat_id: 'boss', role: 'user', actor_name: 'Босс', content: 'первое', created_at: '2025-06-01T06:00:00Z' },
      { id: 2, channel: 'whatsapp', chat_id: 'boss', role: 'assistant', actor_name: 'Бот', content: 'второе', created_at: '2025-06-01T06:05:00Z' },
    ];
  },
};

const orig = Module.prototype.require;
Module.prototype.require = function (id) {
  if (id === '../services/mysql') return mysqlMock;
  return orig.apply(this, arguments);
};
delete require.cache[require.resolve('../../src/tools/recallByDate')];
const { handler } = require('../../src/tools/recallByDate');
Module.prototype.require = orig;

describe('recall_by_date', () => {
  beforeEach(() => { lastArgs = null; });

  test('период из дат: даёт сообщения и переводит границы в UTC', async () => {
    const r = await handler({ from: '2025-06-01', to: '2025-06-01' }, { channel: 'whatsapp', chatId: 'boss', role: 'boss' });
    assert.equal(r.success, true);
    assert.equal(r.count, 2);
    assert.equal(r.messages[0].who, 'Босс');
    // UTC+5: from 00:00 местного = 2025-05-31T19:00Z, to конец дня = 2025-06-01T18:59:59.999Z
    assert.equal(lastArgs.fromUtc.toISOString(), '2025-05-31T19:00:00.000Z');
    assert.equal(lastArgs.toUtc.toISOString(), '2025-06-01T18:59:59.999Z');
  });

  test('битая дата начала → bad_from', async () => {
    const r = await handler({ from: 'вчера' }, { channel: 'whatsapp', chatId: 'boss' });
    assert.equal(r.success, false);
    assert.equal(r.reason, 'bad_from');
  });

  test('from позже to → bad_range', async () => {
    const r = await handler({ from: '2025-06-10', to: '2025-06-01' }, { channel: 'whatsapp', chatId: 'boss' });
    assert.equal(r.success, false);
    assert.equal(r.reason, 'bad_range');
  });

  test('query сужает по словам (tokens пробрасываются)', async () => {
    await handler({ from: '2025-06-01', query: 'оплата счёт' }, { channel: 'whatsapp', chatId: 'boss' });
    assert.ok(Array.isArray(lastArgs.tokens) && lastArgs.tokens.length >= 1);
  });

  test('сотруднику scope=all проходит с viewer (не босс)', async () => {
    await handler({ from: '2025-06-01', scope: 'all' }, { channel: 'whatsapp', chatId: 'emp1', role: 'employee' });
    assert.equal(lastArgs.scope, 'all');
    assert.deepEqual(lastArgs.viewer, { channel: 'whatsapp', chatId: 'emp1', isBoss: false });
  });

  test('боссу scope=all проходит с viewer.isBoss=true', async () => {
    await handler({ from: '2025-06-01', scope: 'all' }, { channel: 'whatsapp', chatId: 'boss', role: 'boss' });
    assert.equal(lastArgs.scope, 'all');
    assert.equal(lastArgs.viewer.isBoss, true);
  });

  test('без to — конец периода = сейчас (успех)', async () => {
    const r = await handler({ from: '2025-06-01' }, { channel: 'whatsapp', chatId: 'boss' });
    assert.equal(r.success, true);
    assert.ok(lastArgs.toUtc instanceof Date);
  });
});

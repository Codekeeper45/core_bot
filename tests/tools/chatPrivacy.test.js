'use strict';
// manage_chat_privacy: приватность ТЕКУЩЕГО чата для общего поиска памяти.
const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');

const store = new Map(); // `${channel}:${chatId}` → privacy
const calls = [];
const mysqlMock = {
  setChatPrivacy: async (channel, chatId, privacy) => {
    calls.push({ fn: 'set', channel, chatId, privacy });
    const value = privacy === 'private' ? 'private' : 'work';
    store.set(`${channel}:${chatId}`, value);
    return value;
  },
  getChatPrivacy: async (channel, chatId) => store.get(`${channel}:${chatId}`) || 'work',
};

const orig = Module.prototype.require;
Module.prototype.require = function (id) {
  if (id === '../services/mysql') return mysqlMock;
  return orig.apply(this, arguments);
};
const { handler } = require('../../src/tools/chatPrivacy');
Module.prototype.require = orig;

describe('manage_chat_privacy', () => {
  beforeEach(() => { store.clear(); calls.length = 0; });

  test('status по умолчанию — work', async () => {
    const r = await handler({ action: 'status' }, { channel: 'whatsapp', chatId: '111' });
    assert.equal(r.success, true);
    assert.equal(r.privacy, 'work');
  });

  test('set_private действует только на ТЕКУЩИЙ чат из context', async () => {
    const r = await handler({ action: 'set_private' }, { channel: 'whatsapp', chatId: '111' });
    assert.equal(r.success, true);
    assert.equal(r.privacy, 'private');
    assert.deepEqual(calls[0], { fn: 'set', channel: 'whatsapp', chatId: '111', privacy: 'private' });
    // другой чат не затронут
    const other = await handler({ action: 'status' }, { channel: 'whatsapp', chatId: '222' });
    assert.equal(other.privacy, 'work');
  });

  test('set_work возвращает чат в общий доступ', async () => {
    await handler({ action: 'set_private' }, { channel: 'telegram', chatId: '5' });
    const r = await handler({ action: 'set_work' }, { channel: 'telegram', chatId: '5' });
    assert.equal(r.privacy, 'work');
    const st = await handler({ action: 'status' }, { channel: 'telegram', chatId: '5' });
    assert.equal(st.privacy, 'work');
  });

  test('неизвестное действие → invalid_action', async () => {
    const r = await handler({ action: 'nope' }, { channel: 'whatsapp', chatId: '1' });
    assert.equal(r.success, false);
    assert.equal(r.reason, 'invalid_action');
  });
});

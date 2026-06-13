'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

// Мок mysql (паттерн tests/tools/listEmployees.test.js).
let store = null; // { channel, chatId, phone, until }
const mysqlMock = {
  setQuiet: async (channel, chatId, phone, untilUtc) => { store = { channel, chatId, phone, until: untilUtc }; return true; },
  clearQuiet: async (channel, chatId) => { const had = !!store; store = null; return had; },
  getQuiet: async (channel, chatId) => {
    if (!store) return null;
    const active = store.until == null ? 1 : (new Date(store.until.replace(' ', 'T') + 'Z').getTime() > Date.now() ? 1 : 0);
    return { owner_channel: channel, owner_chat_id: chatId, owner_phone: store.phone, quiet_until: store.until, active };
  },
};

const Module = require('module');
const orig = Module.prototype.require;
Module.prototype.require = function (id) {
  if (id === '../services/mysql') return mysqlMock;
  return orig.apply(this, arguments);
};
delete require.cache[require.resolve('../../src/tools/quietMode')];
const { handler, definition } = require('../../src/tools/quietMode');
Module.prototype.require = orig;

const ctx = { channel: 'whatsapp', chatId: 'boss-1', phone: '+7 707 123 45 67' };

describe('quiet_mode', () => {
  test('on (бессрочно) → сохраняет без until, телефон нормализован', async () => {
    store = null;
    const r = await handler({ action: 'on' }, ctx);
    assert.equal(r.success, true);
    assert.equal(r.quiet, true);
    assert.equal(r.until_local, null);
    assert.equal(store.until, null);
    assert.equal(store.phone, '77071234567');
  });

  test('on с minutes → ставит until в будущем', async () => {
    store = null;
    const r = await handler({ action: 'on', minutes: 60 }, ctx);
    assert.equal(r.success, true);
    assert.ok(r.until_local, 'должно вернуть until_local');
    assert.ok(store.until, 'until сохранён');
  });

  test('on с кривыми minutes → ошибка', async () => {
    const r = await handler({ action: 'on', minutes: 0 }, ctx);
    assert.equal(r.success, false);
    const r2 = await handler({ action: 'on', minutes: 99999 }, ctx);
    assert.equal(r2.success, false);
  });

  test('status отражает включённый режим, off снимает', async () => {
    store = { channel: 'whatsapp', chatId: 'boss-1', phone: '77071234567', until: null };
    const s = await handler({ action: 'status' }, ctx);
    assert.equal(s.quiet, true);
    const off = await handler({ action: 'off' }, ctx);
    assert.equal(off.success, true);
    assert.equal(off.quiet, false);
    const s2 = await handler({ action: 'status' }, ctx);
    assert.equal(s2.quiet, false);
  });

  test('definition: имя и действия', () => {
    assert.equal(definition.function.name, 'quiet_mode');
    assert.deepEqual(definition.function.parameters.properties.action.enum, ['on', 'off', 'status']);
  });
});

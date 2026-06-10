'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

// Моки scheduler / mysql / config через подмену require.
const calls = [];
let employeeLookup = null;
const schedulerMock = {
  getState: () => ({ enabled: true, morning_hour: 9, evening_hour: 18 }),
  setEnabled: async (on) => { calls.push(['setEnabled', on]); return { enabled: on }; },
  setHours: async (h) => { calls.push(['setHours', h]); return { ...h }; },
  runMorningSummary: async () => { calls.push(['morning']); return { sent: 1, total: 1 }; },
  runEveningReminders: async () => { calls.push(['evening']); return { sent: 2, total: 3 }; },
};
const Module = require('module');
const originalRequire = Module.prototype.require;
Module.prototype.require = function (id) {
  if (id === '../services/reportScheduler') return schedulerMock;
  return originalRequire.apply(this, arguments);
};
const { handler, definition } = require('../../src/tools/manageScheduler');
Module.prototype.require = originalRequire;

// Гейт по роли — на уровне tools/index.js (executeToolCall). Сам handler роль не
// проверяет, поэтому в этих тестах считаем, что до него дошёл уже босс.
const bossCtx = { channel: 'whatsapp', chatId: '77770000001@s.whatsapp.net', phone: '77770000001', role: 'boss' };
void employeeLookup;

describe('manage_scheduler', () => {
  test('definition is a valid tool', () => {
    assert.equal(definition.function.name, 'manage_scheduler');
    assert.ok(definition.function.parameters.properties.action.enum.includes('set_times'));
  });

  test('status for boss', async () => {
    employeeLookup = null;
    const r = await handler({ action: 'status' }, bossCtx);
    assert.equal(r.success, true);
    assert.equal(r.scheduler.morning_hour, 9);
  });

  test('enable/disable call scheduler and persist intent', async () => {
    employeeLookup = null;
    calls.length = 0;
    await handler({ action: 'disable' }, bossCtx);
    await handler({ action: 'enable' }, bossCtx);
    assert.deepEqual(calls, [['setEnabled', false], ['setEnabled', true]]);
  });

  test('set_times requires at least one hour', async () => {
    employeeLookup = null;
    const r = await handler({ action: 'set_times' }, bossCtx);
    assert.equal(r.success, false);
    const ok = await handler({ action: 'set_times', evening_hour: 19 }, bossCtx);
    assert.equal(ok.success, true);
  });

  test('run_*_now trigger immediate sends', async () => {
    employeeLookup = null;
    calls.length = 0;
    const m = await handler({ action: 'run_morning_now' }, bossCtx);
    const e = await handler({ action: 'run_evening_now' }, bossCtx);
    assert.equal(m.success, true);
    assert.equal(e.sent, 2);
    assert.deepEqual(calls, [['morning'], ['evening']]);
  });

});

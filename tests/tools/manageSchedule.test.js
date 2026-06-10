'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const created = [];
let ownerRows = [];
const mysqlMock = {
  createSchedule: async (s) => { created.push(s); return 42; },
  listSchedulesByOwner: async () => ownerRows,
  getSchedule: async (id) => ownerRows.find((r) => r.id === id) || null,
  updateSchedule: async () => 1,
  setScheduleEnabled: async () => true,
  deleteSchedule: async () => true,
};

const Module = require('module');
const originalRequire = Module.prototype.require;
Module.prototype.require = function (id) {
  if (id === '../services/mysql') return mysqlMock;
  return originalRequire.apply(this, arguments);
};
const { handler, definition } = require('../../src/tools/manageSchedule');
Module.prototype.require = originalRequire;

const ctx = { channel: 'whatsapp', chatId: '77770000001', phone: '77770000001', role: 'boss' };

describe('manage_schedule', () => {
  test('definition валиден', () => {
    assert.equal(definition.function.name, 'manage_schedule');
    assert.ok(definition.function.parameters.properties.kind.enum.includes('interval'));
  });

  test('create daily — успех, поля сохранены', async () => {
    created.length = 0;
    const r = await handler({ action: 'create', title: 'Сводка', instruction: 'дай сводку', kind: 'daily', at_hour: 9, at_minute: 30 }, ctx);
    assert.equal(r.success, true);
    assert.equal(r.id, 42);
    assert.equal(created[0].at_hour, 9);
    assert.equal(created[0].at_minute, 30);
    assert.equal(created[0].owner_chat_id, '77770000001');
  });

  test('create once — успех с UTC run_at', async () => {
    created.length = 0;
    const r = await handler({ action: 'create', title: 'Напоминание', instruction: 'позвони', kind: 'once', run_at: '2030-01-01 10:00:00' }, ctx);
    assert.equal(r.success, true);
    assert.equal(created[0].run_at, '2030-01-01 10:00:00');
  });

  test('create once в прошлом → warning, но создаётся', async () => {
    created.length = 0;
    const r = await handler({ action: 'create', title: 'X', instruction: 'y', kind: 'once', run_at: '2020-01-01 10:00:00' }, ctx);
    assert.equal(r.success, true);
    assert.ok(r.warnings.length > 0);
  });

  test('валидация: нет instruction → ошибка', async () => {
    const r = await handler({ action: 'create', title: 'X', kind: 'daily', at_hour: 9 }, ctx);
    assert.equal(r.success, false);
    assert.match(r.message, /instruction/);
  });

  test('валидация: weekly без weekdays → ошибка', async () => {
    const r = await handler({ action: 'create', title: 'X', instruction: 'y', kind: 'weekly', at_hour: 9 }, ctx);
    assert.equal(r.success, false);
    assert.match(r.message, /weekdays/);
  });

  test('валидация: at_hour вне диапазона → ошибка', async () => {
    const r = await handler({ action: 'create', title: 'X', instruction: 'y', kind: 'daily', at_hour: 25 }, ctx);
    assert.equal(r.success, false);
    assert.match(r.message, /at_hour/);
  });

  test('list — отдаёт расписания владельца с описанием «когда»', async () => {
    ownerRows = [{ id: 1, title: 'Сводка', kind: 'daily', at_hour: 9, at_minute: 0, enabled: 1 }];
    const r = await handler({ action: 'list' }, ctx);
    assert.equal(r.success, true);
    assert.equal(r.count, 1);
    assert.match(r.schedules[0].when, /каждый день в 09:00/);
  });

  test('cancel — мягкое выключение', async () => {
    ownerRows = [{ id: 7, title: 'X', kind: 'daily', at_hour: 9 }];
    const r = await handler({ action: 'cancel', id: 7 }, ctx);
    assert.equal(r.success, true);
    assert.equal(r.disabled, true);
  });

  test('cancel несуществующего → ошибка', async () => {
    ownerRows = [];
    const r = await handler({ action: 'cancel', id: 999 }, ctx);
    assert.equal(r.success, false);
  });
});

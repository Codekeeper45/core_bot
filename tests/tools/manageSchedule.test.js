'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const created = [];
const updates = [];
let ownerRows = [];
let activeCount = 0;
const mysqlMock = {
  createSchedule: async (s) => { created.push(s); return 42; },
  listSchedulesByOwner: async () => ownerRows,
  getSchedule: async (id) => ownerRows.find((r) => r.id === id) || null,
  updateSchedule: async (id, fields) => { updates.push([id, fields]); return Object.keys(fields).length; },
  setScheduleEnabled: async (id, on) => { updates.push([id, { enabled: on ? 1 : 0 }]); return true; },
  deleteSchedule: async () => true,
  countSchedules: async () => activeCount,
  listScheduleRuns: async () => mysqlMock._runs,
  _runs: [],
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
// Строка-владелец под ctx (для update/cancel/enable/run_now).
function owned(extra) {
  return { owner_channel: 'whatsapp', owner_chat_id: '77770000001', enabled: 1, last_run_at: null, ...extra };
}
function reset() { created.length = 0; updates.length = 0; ownerRows = []; activeCount = 0; }

describe('manage_schedule: create', () => {
  test('definition валиден', () => {
    assert.equal(definition.function.name, 'manage_schedule');
    assert.ok(definition.function.parameters.properties.action.enum.includes('enable'));
  });

  test('daily — успех, поля сохранены, next_run_at предвычислен', async () => {
    reset();
    const r = await handler({ action: 'create', title: 'Сводка', instruction: 'дай сводку', kind: 'daily', at_hour: 9, at_minute: 30 }, ctx);
    assert.equal(r.success, true);
    assert.equal(r.id, 42);
    assert.equal(created[0].at_hour, 9);
    assert.equal(created[0].owner_chat_id, '77770000001');
    assert.match(String(created[0].next_run_at), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });

  test('once: run_at — ЛОКАЛЬНОЕ время, в БД уходит UTC (−5ч)', async () => {
    reset();
    const r = await handler({ action: 'create', title: 'Напоминание', instruction: 'позвони', kind: 'once', run_at: '2030-01-01 10:00:00' }, ctx);
    assert.equal(r.success, true);
    assert.equal(created[0].run_at, '2030-01-01 05:00:00');
    assert.equal(created[0].next_run_at, '2030-01-01 05:00:00');
  });

  test('once в прошлом → warning, но создаётся', async () => {
    reset();
    const r = await handler({ action: 'create', title: 'X', instruction: 'y', kind: 'once', run_at: '2020-01-01 10:00:00' }, ctx);
    assert.equal(r.success, true);
    assert.ok(r.warnings.length > 0);
  });

  test('interval: не сразу, а через interval_min; меньше минимума → ошибка', async () => {
    reset();
    const r = await handler({ action: 'create', title: 'X', instruction: 'y', kind: 'interval', interval_min: 30 }, ctx);
    assert.equal(r.success, true);
    const next = new Date(String(created[0].next_run_at).replace(' ', 'T') + 'Z');
    assert.ok(next.getTime() > Date.now() + 25 * 60000, 'первый запуск не раньше чем через interval');
    const bad = await handler({ action: 'create', title: 'X', instruction: 'y', kind: 'interval', interval_min: 1 }, ctx);
    assert.equal(bad.success, false);
    assert.match(bad.message, /interval_min/);
  });

  test('delay_minutes: «через час» → run_at = now+60м UTC, без арифметики у LLM', async () => {
    reset();
    const before = Date.now();
    const r = await handler({ action: 'create', title: 'Напоминание', instruction: 'напиши боссу', kind: 'once', delay_minutes: 60 }, ctx);
    assert.equal(r.success, true);
    assert.ok(r.run_at_local, 'ответ содержит run_at_local для подтверждения боссу');
    assert.match(r.confirm_to_boss, /через 60 мин/);
    const runAt = new Date(String(created[0].run_at).replace(' ', 'T') + 'Z').getTime();
    const expected = before + 60 * 60000;
    assert.ok(Math.abs(runAt - expected) < 5000, `run_at ≈ now+60м (расхождение ${runAt - expected}мс)`);
    assert.equal(created[0].next_run_at, created[0].run_at);
  });

  test('delay_minutes: оба с run_at → ошибка; ни одного → ошибка; вне диапазона → ошибка', async () => {
    reset();
    const both = await handler({ action: 'create', title: 'X', instruction: 'y', kind: 'once', delay_minutes: 60, run_at: '2030-01-01 10:00:00' }, ctx);
    assert.equal(both.success, false);
    assert.match(both.message, /РОВНО ОДНО/i);
    const neither = await handler({ action: 'create', title: 'X', instruction: 'y', kind: 'once' }, ctx);
    assert.equal(neither.success, false);
    assert.match(neither.message, /delay_minutes|run_at/);
    for (const bad of [0, -5, 99999]) {
      const r = await handler({ action: 'create', title: 'X', instruction: 'y', kind: 'once', delay_minutes: bad }, ctx);
      assert.equal(r.success, false, `delay_minutes=${bad} должен быть отклонён`);
    }
  });

  test('потолок активных расписаний → ошибка', async () => {
    reset();
    activeCount = 1000;
    const r = await handler({ action: 'create', title: 'X', instruction: 'y', kind: 'daily', at_hour: 9 }, ctx);
    assert.equal(r.success, false);
    assert.match(r.message, /лимит/i);
  });

  test('валидация: нет instruction / weekly без weekdays / at_hour вне диапазона', async () => {
    reset();
    assert.equal((await handler({ action: 'create', title: 'X', kind: 'daily', at_hour: 9 }, ctx)).success, false);
    assert.match((await handler({ action: 'create', title: 'X', instruction: 'y', kind: 'weekly', at_hour: 9 }, ctx)).message, /weekdays/);
    assert.match((await handler({ action: 'create', title: 'X', instruction: 'y', kind: 'daily', at_hour: 25 }, ctx)).message, /at_hour/);
  });
});

describe('manage_schedule: list', () => {
  test('отдаёт расписания владельца, once-время — локальное, есть next_run_local', async () => {
    reset();
    ownerRows = [
      owned({ id: 1, title: 'Сводка', kind: 'daily', at_hour: 9, at_minute: 0, next_run_at: '2026-06-09 04:00:00' }),
      owned({ id: 2, title: 'Звонок', kind: 'once', run_at: '2026-06-08 05:00:00', next_run_at: '2026-06-08 05:00:00' }),
    ];
    const r = await handler({ action: 'list' }, ctx);
    assert.equal(r.success, true);
    assert.equal(r.count, 2);
    assert.match(r.schedules[0].when, /каждый день в 09:00/);
    assert.match(r.schedules[0].next_run_local, /2026-06-09 09:00/);
    assert.match(r.schedules[1].when, /2026-06-08 10:00/); // 05:00 UTC = 10:00 локально
  });
});

describe('manage_schedule: update', () => {
  test('смена kind на weekly без weekdays → ошибка (merge-валидация)', async () => {
    reset();
    ownerRows = [owned({ id: 5, title: 'X', instruction: 'y', kind: 'daily', at_hour: 9, at_minute: 0, weekdays: null })];
    const r = await handler({ action: 'update', id: 5, kind: 'weekly' }, ctx);
    assert.equal(r.success, false);
    assert.match(r.message, /weekdays/);
  });

  test('перенос выполненного once: сбрасывает last_run_at/fail_count, включает, пересчитывает next_run_at', async () => {
    reset();
    ownerRows = [owned({ id: 6, title: 'X', instruction: 'y', kind: 'once', run_at: '2026-01-01 05:00:00', last_run_at: '2026-01-01 05:00:10', enabled: 0 })];
    const r = await handler({ action: 'update', id: 6, run_at: '2030-01-01 10:00:00' }, ctx);
    assert.equal(r.success, true);
    const [, fields] = updates[0];
    assert.equal(fields.run_at, '2030-01-01 05:00:00');     // локальное → UTC
    assert.equal(fields.next_run_at, '2030-01-01 05:00:00');
    assert.equal(fields.last_run_at, null);
    assert.equal(fields.fail_count, 0);
    assert.equal(fields.enabled, 1);
  });

  test('update с delay_minutes: перенос «давай через 2 часа» → перевзвод', async () => {
    reset();
    ownerRows = [owned({ id: 10, title: 'X', instruction: 'y', kind: 'once', run_at: '2026-01-01 05:00:00', last_run_at: '2026-01-01 05:00:10', enabled: 0 })];
    const before = Date.now();
    const r = await handler({ action: 'update', id: 10, delay_minutes: 120 }, ctx);
    assert.equal(r.success, true);
    const [, fields] = updates[0];
    const runAt = new Date(String(fields.run_at).replace(' ', 'T') + 'Z').getTime();
    assert.ok(Math.abs(runAt - (before + 120 * 60000)) < 5000);
    assert.equal(fields.enabled, 1);
    assert.equal(fields.last_run_at, null);
  });

  test('update delay_minutes на daily-расписании → ошибка (только once)', async () => {
    reset();
    ownerRows = [owned({ id: 11, title: 'X', instruction: 'y', kind: 'daily', at_hour: 9, at_minute: 0 })];
    const r = await handler({ action: 'update', id: 11, delay_minutes: 30 }, ctx);
    assert.equal(r.success, false);
    assert.match(r.message, /once/);
  });

  test('чужое расписание (другой владелец) → не найдено', async () => {
    reset();
    ownerRows = [{ id: 7, owner_channel: 'telegram', owner_chat_id: '999', kind: 'daily', at_hour: 9, title: 'X', instruction: 'y' }];
    const r = await handler({ action: 'update', id: 7, at_hour: 10 }, ctx);
    assert.equal(r.success, false);
    assert.match(r.message, /не найдено/i);
  });
});

describe('manage_schedule: enable / cancel', () => {
  test('enable включает выключенное и пересчитывает next_run_at', async () => {
    reset();
    ownerRows = [owned({ id: 8, title: 'X', instruction: 'y', kind: 'daily', at_hour: 9, at_minute: 0, enabled: 0, fail_count: 3 })];
    const r = await handler({ action: 'enable', id: 8 }, ctx);
    assert.equal(r.success, true);
    const [, fields] = updates[0];
    assert.equal(fields.enabled, 1);
    assert.equal(fields.fail_count, 0);
    assert.match(String(fields.next_run_at), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });

  test('cancel — мягкое выключение; несуществующее → ошибка', async () => {
    reset();
    ownerRows = [owned({ id: 9, title: 'X', kind: 'daily', at_hour: 9 })];
    const r = await handler({ action: 'cancel', id: 9 }, ctx);
    assert.equal(r.success, true);
    assert.equal(r.disabled, true);
    assert.equal((await handler({ action: 'cancel', id: 999 }, ctx)).success, false);
  });
});

describe('manage_schedule: run_now', () => {
  test('возвращает инструкцию для немедленного выполнения текущим циклом, не трогая расписание', async () => {
    reset();
    ownerRows = [owned({ id: 10, title: 'Проверка', instruction: 'проверь план X', kind: 'once', run_at: '2030-01-01 05:00:00' })];
    const r = await handler({ action: 'run_now', id: 10 }, ctx);
    assert.equal(r.success, true);
    assert.equal(r.execute_now, true);
    assert.match(r.instruction, /проверь план X/);
    assert.equal(updates.length, 0); // состояние расписания не изменилось
  });
});

describe('manage_schedule: history', () => {
  test('журнал запусков своего расписания, время локальное', async () => {
    reset();
    ownerRows = [owned({ id: 12, title: 'Сводка', instruction: 'y', kind: 'daily', at_hour: 9, at_minute: 0 })];
    mysqlMock._runs = [
      { status: 'ok', detail: null, ran_at: '2026-06-09 04:00:30' },
      { status: 'missed', detail: 'опоздание 150 мин > окна 120 мин', ran_at: '2026-06-08 06:30:00' },
    ];
    const r = await handler({ action: 'history', id: 12 }, ctx);
    assert.equal(r.success, true);
    assert.equal(r.runs.length, 2);
    assert.equal(r.runs[0].status, 'ok');
    assert.match(r.runs[0].ran_at_local, /2026-06-09 09:00/); // 04:00 UTC = 09:00 локально
    assert.match(r.runs[1].detail, /опоздание/);
  });

  test('пустой журнал → понятная note; чужое расписание → не найдено', async () => {
    reset();
    ownerRows = [owned({ id: 13, title: 'X', instruction: 'y', kind: 'daily', at_hour: 9, at_minute: 0 })];
    mysqlMock._runs = [];
    const r = await handler({ action: 'history', id: 13 }, ctx);
    assert.equal(r.success, true);
    assert.match(r.note, /Запусков ещё не было/);
    assert.equal((await handler({ action: 'history', id: 999 }, ctx)).success, false);
  });
});

'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

// Мок mysql через подмену require (как в tests/dispatcher.test.js).
const calls = [];
const mysqlMock = {
  listEnabledSchedules: async () => mysqlMock._rows,
  markScheduleRun: async (id, when, status) => calls.push(['markRun', id, status]),
  touchScheduleStatus: async (id, status) => calls.push(['touch', id, status]),
  bumpScheduleFail: async (id, status) => calls.push(['bumpFail', id, status]),
  _rows: [],
};

const Module = require('module');
const originalRequire = Module.prototype.require;
Module.prototype.require = function (id) {
  if (id === './mysql') return mysqlMock;
  return originalRequire.apply(this, arguments);
};
const runner = require('../src/services/scheduledRunner');
Module.prototype.require = originalRequire;

const { isDue, sameLocalMinute, csvHas, tick, setDeliver } = runner._internals;

// UTC helper: локальное (UTC+5) HH = UTC HH-5. Напр. 9:00 локально = 4:00 UTC.
const utc = (y, mo, d, h, mi = 0) => new Date(Date.UTC(y, mo - 1, d, h, mi));

describe('isDue', () => {
  test('daily срабатывает в нужную локальную минуту, не раньше/позже', () => {
    const row = { enabled: 1, kind: 'daily', at_hour: 9, at_minute: 0, last_run_at: null };
    assert.equal(isDue(row, utc(2026, 6, 8, 4, 0)), true);   // 09:00 локально
    assert.equal(isDue(row, utc(2026, 6, 8, 3, 59)), false); // 08:59
    assert.equal(isDue(row, utc(2026, 6, 8, 4, 1)), false);  // 09:01
  });

  test('weekly только в указанные ISO-дни', () => {
    // 08.06.2026 — понедельник (ISO 1)
    const mon = { enabled: 1, kind: 'weekly', at_hour: 9, at_minute: 0, weekdays: '1,3', last_run_at: null };
    assert.equal(isDue(mon, utc(2026, 6, 8, 4, 0)), true);  // Пн
    assert.equal(isDue(mon, utc(2026, 6, 9, 4, 0)), false); // Вт (2) не в списке
  });

  test('monthly только в указанные числа', () => {
    const row = { enabled: 1, kind: 'monthly', at_hour: 9, at_minute: 0, month_days: '1,15', last_run_at: null };
    assert.equal(isDue(row, utc(2026, 6, 15, 4, 0)), true);
    assert.equal(isDue(row, utc(2026, 6, 16, 4, 0)), false);
  });

  test('once — due при run_at<=now и нет last_run; досыл прошедшего', () => {
    const future = { enabled: 1, kind: 'once', run_at: '2026-06-08 10:00:00', last_run_at: null };
    assert.equal(isDue(future, utc(2026, 6, 8, 9, 0)), false); // ещё рано
    assert.equal(isDue(future, utc(2026, 6, 8, 10, 0)), true); // настало
    const past = { enabled: 1, kind: 'once', run_at: '2026-06-01 10:00:00', last_run_at: null };
    assert.equal(isDue(past, utc(2026, 6, 8, 9, 0)), true);    // простой — досыл
    const done = { enabled: 1, kind: 'once', run_at: '2026-06-01 10:00:00', last_run_at: '2026-06-01 10:00:05' };
    assert.equal(isDue(done, utc(2026, 6, 8, 9, 0)), false);   // уже выполнено
  });

  test('interval — по разнице времени от last_run', () => {
    const fresh = { enabled: 1, kind: 'interval', interval_min: 30, last_run_at: null };
    assert.equal(isDue(fresh, utc(2026, 6, 8, 9, 0)), true);
    const recent = { enabled: 1, kind: 'interval', interval_min: 30, last_run_at: '2026-06-08T09:00:00Z' };
    assert.equal(isDue(recent, utc(2026, 6, 8, 9, 20)), false); // 20 мин < 30
    assert.equal(isDue(recent, utc(2026, 6, 8, 9, 31)), true);  // 31 мин >= 30
  });

  test('выключенное расписание не due', () => {
    assert.equal(isDue({ enabled: 0, kind: 'daily', at_hour: 9, at_minute: 0 }, utc(2026, 6, 8, 4, 0)), false);
  });

  test('дедуп в минуту: last_run в текущей локальной минуте → не due', () => {
    const row = { enabled: 1, kind: 'daily', at_hour: 9, at_minute: 0, last_run_at: '2026-06-08T04:00:30Z' };
    assert.equal(isDue(row, utc(2026, 6, 8, 4, 0)), false);
    assert.equal(sameLocalMinute('2026-06-08T04:00:30Z', utc(2026, 6, 8, 4, 0)), true);
  });
});

describe('csvHas', () => {
  test('находит число в CSV', () => {
    assert.equal(csvHas('1,3,5', 3), true);
    assert.equal(csvHas('1,3,5', 2), false);
    assert.equal(csvHas('', 1), false);
  });
});

describe('tick', () => {
  test('ok → markRun; lock_busy → touch (last_run не трогаем); running-гард', async () => {
    mysqlMock._rows = [
      { id: 1, enabled: 1, kind: 'daily', at_hour: 9, at_minute: 0, last_run_at: null, owner_channel: 'whatsapp', owner_chat_id: 'a', title: 'T1', instruction: 'do' },
      { id: 2, enabled: 1, kind: 'daily', at_hour: 9, at_minute: 0, last_run_at: null, owner_channel: 'whatsapp', owner_chat_id: 'b', title: 'T2', instruction: 'do' },
    ];
    calls.length = 0;
    // #1 → ok, #2 → lock_busy
    setDeliver(async ({ chatId }) => (chatId === 'a' ? { ok: true } : { ok: false, reason: 'lock_busy' }));
    await tick(utc(2026, 6, 8, 4, 0));
    assert.deepEqual(calls.find((c) => c[1] === 1), ['markRun', 1, 'ok']);
    assert.deepEqual(calls.find((c) => c[1] === 2), ['touch', 2, 'lock_busy']);
  });

  test('agent_error: recurring → markRun (не спам), once → bumpFail', async () => {
    mysqlMock._rows = [
      { id: 3, enabled: 1, kind: 'daily', at_hour: 9, at_minute: 0, last_run_at: null, owner_channel: 'whatsapp', owner_chat_id: 'c', title: 'T3', instruction: 'do' },
      { id: 4, enabled: 1, kind: 'once', run_at: '2026-06-08 04:00:00', last_run_at: null, owner_channel: 'whatsapp', owner_chat_id: 'd', title: 'T4', instruction: 'do' },
    ];
    calls.length = 0;
    setDeliver(async () => ({ ok: false, reason: 'agent_error' }));
    await tick(utc(2026, 6, 8, 4, 0));
    assert.deepEqual(calls.find((c) => c[1] === 3), ['markRun', 3, 'agent_error']);
    assert.deepEqual(calls.find((c) => c[1] === 4), ['bumpFail', 4, 'agent_error']);
  });

  test('running-гард: повторный tick во время незавершённого deliver не дублирует', async () => {
    mysqlMock._rows = [
      { id: 5, enabled: 1, kind: 'daily', at_hour: 9, at_minute: 0, last_run_at: null, owner_channel: 'whatsapp', owner_chat_id: 'e', title: 'T5', instruction: 'do' },
    ];
    calls.length = 0;
    let resolveDeliver;
    setDeliver(() => new Promise((r) => { resolveDeliver = () => r({ ok: true }); }));
    const p1 = tick(utc(2026, 6, 8, 4, 0)); // зависнет на deliver
    await tick(utc(2026, 6, 8, 4, 0));      // должен выйти сразу (running=true)
    resolveDeliver();
    await p1;
    assert.equal(calls.filter((c) => c[0] === 'markRun').length, 1);
  });
});

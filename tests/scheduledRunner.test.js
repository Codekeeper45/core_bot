'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

// Мок mysql через подмену require (как в tests/dispatcher.test.js).
const calls = [];
const mysqlMock = {
  listEnabledSchedules: async () => mysqlMock._rows,
  markScheduleRun: async (id, when, status, next) => calls.push(['markRun', id, status, next]),
  touchScheduleStatus: async (id, status) => calls.push(['touch', id, status]),
  bumpScheduleFail: async (id, status) => calls.push(['bumpFail', id, status]),
  setScheduleNextRun: async (id, next) => calls.push(['setNext', id, next]),
  setScheduleEnabled: async (id, on) => calls.push(['setEnabled', id, on]),
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

const { isDue, tick, setDeliver } = runner._internals;

// UTC helper: локальное (UTC+5) HH = UTC HH-5. Напр. 9:00 локально = 4:00 UTC.
const utc = (y, mo, d, h, mi = 0) => new Date(Date.UTC(y, mo - 1, d, h, mi));

describe('isDue (модель next_run_at)', () => {
  test('due когда next_run_at настал или просрочен', () => {
    const row = { enabled: 1, kind: 'daily', next_run_at: '2026-06-08 04:00:00' };
    assert.equal(isDue(row, utc(2026, 6, 8, 3, 59)), false);
    assert.equal(isDue(row, utc(2026, 6, 8, 4, 0)), true);
    assert.equal(isDue(row, utc(2026, 6, 8, 4, 7)), true); // опоздавший tick всё равно видит
  });

  test('не due: выключено или next_run_at пуст', () => {
    assert.equal(isDue({ enabled: 0, kind: 'daily', next_run_at: '2026-06-08 04:00:00' }, utc(2026, 6, 8, 4, 0)), false);
    assert.equal(isDue({ enabled: 1, kind: 'once', next_run_at: null }, utc(2026, 6, 8, 4, 0)), false);
  });
});

function row(extra) {
  return {
    id: 1, enabled: 1, owner_channel: 'whatsapp', owner_chat_id: 'a',
    title: 'T', instruction: 'do', last_run_at: null, ...extra,
  };
}

describe('tick', () => {
  test('успех recurring → markRun со следующим next_run_at', async () => {
    mysqlMock._rows = [row({ id: 1, kind: 'daily', at_hour: 9, at_minute: 0, next_run_at: '2026-06-08 04:00:00' })];
    calls.length = 0;
    setDeliver(async () => ({ ok: true }));
    await tick(utc(2026, 6, 8, 4, 0));
    const mark = calls.find((c) => c[0] === 'markRun');
    assert.deepEqual(mark.slice(0, 3), ['markRun', 1, 'ok']);
    assert.equal(mark[3], '2026-06-09 04:00:00'); // завтра 9:00 локально
  });

  test('успех once → markRun(next=null) + выключение (завершено)', async () => {
    mysqlMock._rows = [row({ id: 2, kind: 'once', run_at: '2026-06-08 04:00:00', next_run_at: '2026-06-08 04:00:00' })];
    calls.length = 0;
    setDeliver(async () => ({ ok: true }));
    await tick(utc(2026, 6, 8, 4, 0));
    assert.deepEqual(calls.find((c) => c[0] === 'markRun'), ['markRun', 2, 'ok', null]);
    assert.deepEqual(calls.find((c) => c[0] === 'setEnabled'), ['setEnabled', 2, false]);
  });

  test('lock_busy → touch, next_run_at не трогаем → ретрай на следующем tick (фикс пропуска daily)', async () => {
    mysqlMock._rows = [row({ id: 3, kind: 'daily', at_hour: 9, at_minute: 0, next_run_at: '2026-06-08 04:00:00' })];
    calls.length = 0;
    setDeliver(async () => ({ ok: false, reason: 'lock_busy' }));
    await tick(utc(2026, 6, 8, 4, 0));
    assert.deepEqual(calls, [['touch', 3, 'lock_busy']]);
    // следующий tick через минуту — расписание всё ещё due и доставляется
    calls.length = 0;
    setDeliver(async () => ({ ok: true }));
    await tick(utc(2026, 6, 8, 4, 1));
    assert.equal(calls.find((c) => c[0] === 'markRun')[2], 'ok');
  });

  test('просрочка больше окна catch-up → missed + перенос на следующий раз, без доставки', async () => {
    mysqlMock._rows = [row({ id: 4, kind: 'daily', at_hour: 9, at_minute: 0, next_run_at: '2026-06-08 04:00:00' })];
    calls.length = 0;
    let delivered = false;
    setDeliver(async () => { delivered = true; return { ok: true }; });
    await tick(utc(2026, 6, 8, 6, 30)); // опоздание 2.5 ч > 120 мин
    assert.equal(delivered, false);
    const mark = calls.find((c) => c[0] === 'markRun');
    assert.equal(mark[2], 'missed');
    assert.equal(mark[3], '2026-06-09 04:00:00');
  });

  test('once не подчиняется окну catch-up — досылается даже сильно позже', async () => {
    mysqlMock._rows = [row({ id: 5, kind: 'once', run_at: '2026-06-01 04:00:00', next_run_at: '2026-06-01 04:00:00' })];
    calls.length = 0;
    setDeliver(async () => ({ ok: true }));
    await tick(utc(2026, 6, 8, 4, 0)); // неделя простоя
    assert.equal(calls.find((c) => c[0] === 'markRun')[2], 'ok');
  });

  test('agent_error: recurring → markRun со сдвигом (не спам), once → bumpFail (ретрай, cutoff в БД)', async () => {
    mysqlMock._rows = [
      row({ id: 6, kind: 'daily', at_hour: 9, at_minute: 0, next_run_at: '2026-06-08 04:00:00' }),
      row({ id: 7, kind: 'once', run_at: '2026-06-08 04:00:00', next_run_at: '2026-06-08 04:00:00', owner_chat_id: 'b' }),
    ];
    calls.length = 0;
    setDeliver(async () => ({ ok: false, reason: 'agent_error' }));
    await tick(utc(2026, 6, 8, 4, 0));
    const mark = calls.find((c) => c[0] === 'markRun' && c[1] === 6);
    assert.equal(mark[2], 'agent_error');
    assert.equal(mark[3], '2026-06-09 04:00:00');
    assert.deepEqual(calls.find((c) => c[0] === 'bumpFail'), ['bumpFail', 7, 'agent_error']);
  });

  test('backfill: строка без next_run_at получает вычисленный, без доставки в этот tick', async () => {
    mysqlMock._rows = [row({ id: 8, kind: 'daily', at_hour: 9, at_minute: 0, next_run_at: null })];
    calls.length = 0;
    let delivered = false;
    setDeliver(async () => { delivered = true; return { ok: true }; });
    await tick(utc(2026, 6, 8, 3, 0));
    assert.equal(delivered, false);
    assert.deepEqual(calls, [['setNext', 8, '2026-06-08 04:00:00']]);
  });

  test('backfill: завершённое legacy-once (есть last_run_at) → выключение', async () => {
    mysqlMock._rows = [row({ id: 9, kind: 'once', run_at: '2026-06-01 04:00:00', last_run_at: '2026-06-01 04:00:05', next_run_at: null })];
    calls.length = 0;
    setDeliver(async () => ({ ok: true }));
    await tick(utc(2026, 6, 8, 3, 0));
    assert.deepEqual(calls.find((c) => c[0] === 'setEnabled'), ['setEnabled', 9, false]);
    assert.equal(calls.find((c) => c[0] === 'markRun'), undefined);
  });

  test('running-гард: повторный tick во время незавершённого deliver не дублирует', async () => {
    mysqlMock._rows = [row({ id: 10, kind: 'daily', at_hour: 9, at_minute: 0, next_run_at: '2026-06-08 04:00:00' })];
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

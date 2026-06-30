'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

// Сторож исполнения (watchdog): отдельный мок mysql с getTask/getEmployeeById
// (паттерн tests/scheduledRunner.test.js).
const calls = [];
const journal = [];
const mysqlMock = {
  listEnabledSchedules: async () => mysqlMock._rows,
  markScheduleRun: async (id, when, status, next, opts) => calls.push(['markRun', id, status, next, opts || {}]),
  touchScheduleStatus: async (id, status) => calls.push(['touch', id, status]),
  bumpScheduleFail: async (id, status) => calls.push(['bumpFail', id, status]),
  claimSchedule: async (id, expected) => { calls.push(['claim', id, expected]); return true; },
  updateSchedule: async (id, fields) => { calls.push(['update', id, fields]); return Object.keys(fields).length; },
  setScheduleNextRun: async (id, next) => calls.push(['setNext', id, next]),
  setScheduleEnabled: async (id, on) => calls.push(['setEnabled', id, on]),
  logScheduleRun: async (id, title, status, detail) => journal.push({ id, status, detail }),
  cleanupScheduleRuns: async () => 0,
  listActiveQuiet: async () => mysqlMock._quiet,
  getTask: async () => mysqlMock._task,
  getEmployeeById: async () => mysqlMock._emp,
  _rows: [],
  _task: null,
  _emp: null,
  _quiet: [],
};

const Module = require('module');
const originalRequire = Module.prototype.require;
Module.prototype.require = function (id) {
  if (id === './mysql') return mysqlMock;
  return originalRequire.apply(this, arguments);
};
const runner = require('../src/services/scheduledRunner');
Module.prototype.require = originalRequire;

const { tick, isGoalMet, isWatchTerminalStop, setDeliver } = runner._internals;
const utc = (y, mo, d, h, mi = 0) => new Date(Date.UTC(y, mo - 1, d, h, mi));

function watchRow(extra) {
  return {
    id: 1, enabled: 1, owner_channel: 'whatsapp', owner_chat_id: 'boss',
    title: 'Контроль', instruction: 'follow', kind: 'once', last_run_at: null,
    run_at: '2026-06-08 04:00:00', next_run_at: '2026-06-08 04:00:00',
    watch_task_id: 5, watch_goal: 'accepted', nag_interval_min: 10, nag_max: 3, nag_count: 0,
    ...extra,
  };
}

describe('isGoalMet (чистая функция)', () => {
  test('accepted: задача ушла с todo/dispatched', () => {
    for (const s of ['in_progress', 'blocked', 'done']) assert.equal(isGoalMet('accepted', s), true, s);
    for (const s of ['todo', 'dispatched', 'new', 'reassign']) assert.equal(isGoalMet('accepted', s), false, s);
  });
  test('done: только done', () => {
    assert.equal(isGoalMet('done', 'done'), true);
    for (const s of ['in_progress', 'blocked', 'dispatched', 'todo']) assert.equal(isGoalMet('done', s), false, s);
  });
});

describe('isWatchTerminalStop (чистая функция)', () => {
  test('стоп при отсутствии задачи, переназначении и закрытии (done/cancelled)', () => {
    assert.equal(isWatchTerminalStop(null), true);
    for (const s of ['reassign', 'cancelled', 'done']) {
      assert.equal(isWatchTerminalStop({ status: s }), true, s);
    }
  });
  test('продолжаем стеречь активные статусы', () => {
    for (const s of ['todo', 'dispatched', 'in_progress', 'blocked']) {
      assert.equal(isWatchTerminalStop({ status: s }), false, s);
    }
  });
  test('cancelled: цель done НЕ достигнута, но сторож завершается по terminal-stop', () => {
    assert.equal(isGoalMet('done', 'cancelled'), false);
    assert.equal(isWatchTerminalStop({ status: 'cancelled' }), true);
  });
});

describe('watchdog в tick', () => {
  test('цель достигнута → доставки нет, расписание выключено, журнал watch_done', async () => {
    mysqlMock._rows = [watchRow({ watch_goal: 'accepted' })];
    mysqlMock._task = { id: 5, title: 'Доставка', status: 'in_progress', assignee_id: 9 };
    calls.length = 0; journal.length = 0;
    let delivered = false;
    setDeliver(async () => { delivered = true; return { ok: true }; });
    await tick(utc(2026, 6, 8, 4, 0));
    assert.equal(delivered, false, 'кто уже принял — не дёргаем');
    assert.equal(calls.find((c) => c[0] === 'markRun')[2], 'watch_done');
    assert.deepEqual(calls.find((c) => c[0] === 'setEnabled'), ['setEnabled', 1, false]);
    assert.equal(journal.find((j) => j.id === 1).status, 'watch_done');
  });

  test('не достигнута, есть попытки → напоминание СОТРУДНИКУ, счётчик растёт, next=now+N', async () => {
    mysqlMock._rows = [watchRow({ watch_goal: 'accepted', nag_count: 0 })];
    mysqlMock._task = { id: 5, title: 'Доставка', status: 'dispatched', assignee_id: 9 };
    mysqlMock._emp = { id: 9, name: 'Курбан' };
    calls.length = 0; journal.length = 0;
    let instr = ''; let arg = null;
    setDeliver(async (a) => { arg = a; instr = a.instruction; return { ok: true }; });
    await tick(utc(2026, 6, 8, 4, 0));
    assert.match(instr, /message_employee/, 'погоня велит писать сотруднику');
    assert.match(instr, /Курбан/);
    assert.equal(arg.silentToOwner, true, 'погоня боссу не отправляется (silentToOwner)');
    const mark = calls.find((c) => c[0] === 'markRun');
    assert.equal(mark[2], 'watch');
    assert.equal(mark[3], '2026-06-08 04:10:00');
    assert.deepEqual(mark[4], { firePhase: 'watch', nagCount: 1 });
    assert.equal(calls.find((c) => c[0] === 'setEnabled'), undefined);
  });

  test('попытки исчерпаны (k>max) → эскалация боссу, выключение, журнал watch_escalated', async () => {
    // nag_count=3, nag_max=3 → k=4 > 3 → эскалация (было 3 напоминания)
    mysqlMock._rows = [watchRow({ watch_goal: 'done', fire_phase: 'watch', nag_count: 3, nag_max: 3,
      next_run_at: '2026-06-08 04:30:00' })];
    mysqlMock._task = { id: 5, title: 'Отчёт', status: 'dispatched', assignee_id: 9 };
    mysqlMock._emp = { id: 9, name: 'Илья' };
    calls.length = 0; journal.length = 0;
    let instr = ''; let arg = null;
    setDeliver(async (a) => { arg = a; instr = a.instruction; return { ok: true }; });
    await tick(utc(2026, 6, 8, 4, 30));
    assert.match(instr, /ЭСКАЛАЦИЯ/);
    assert.match(instr, /БОССУ/);
    assert.match(instr, /Илья/);
    assert.ok(!arg.silentToOwner, 'эскалация боссу — НЕ тихая');
    assert.equal(calls.find((c) => c[0] === 'markRun')[2], 'watch_escalated');
    assert.deepEqual(calls.find((c) => c[0] === 'setEnabled'), ['setEnabled', 1, false]);
    assert.equal(journal.find((j) => j.id === 1).status, 'watch_escalated');
  });

  test('задача исчезла/переназначается → стоп без погони (watch_stopped)', async () => {
    // нет задачи
    mysqlMock._rows = [watchRow({})];
    mysqlMock._task = null;
    calls.length = 0; journal.length = 0;
    let delivered = false;
    setDeliver(async () => { delivered = true; return { ok: true }; });
    await tick(utc(2026, 6, 8, 4, 0));
    assert.equal(delivered, false);
    assert.deepEqual(calls.find((c) => c[0] === 'setEnabled'), ['setEnabled', 1, false]);
    assert.equal(journal.find((j) => j.id === 1).status, 'watch_stopped');
    // переназначается
    mysqlMock._rows = [watchRow({ id: 2 })];
    mysqlMock._task = { id: 5, title: 'X', status: 'reassign', assignee_id: 9 };
    calls.length = 0; journal.length = 0;
    await tick(utc(2026, 6, 8, 4, 0));
    assert.equal(journal.find((j) => j.id === 2).status, 'watch_stopped');
  });

  test('lock_busy при погоне → момент восстановлен, счётчик не растёт', async () => {
    mysqlMock._rows = [watchRow({ nag_count: 0 })];
    mysqlMock._task = { id: 5, title: 'X', status: 'dispatched', assignee_id: 9 };
    calls.length = 0;
    mysqlMock._quiet = [];
    setDeliver(async () => ({ ok: false, reason: 'lock_busy' }));
    await tick(utc(2026, 6, 8, 4, 0));
    assert.deepEqual(calls.find((c) => c[0] === 'setNext'), ['setNext', 1, '2026-06-08 04:00:00']);
    assert.equal(calls.find((c) => c[0] === 'markRun'), undefined);
  });
});

// M4: тихий режим (/stop) уважают напоминания/сводки, НО сторож (watch) — нет:
// его эскалация это критичный алерт, который босс сам себе настроил.
describe('watchdog мимо тихого режима (M4)', () => {
  test('owner в quiet + watch-строка → погоня/эскалация ВСЁ РАВНО идёт', async () => {
    mysqlMock._rows = [watchRow({ nag_count: 0 })];
    mysqlMock._task = { id: 5, title: 'Доставка', status: 'dispatched', assignee_id: 9 };
    mysqlMock._emp = { id: 9, name: 'Курбан' };
    mysqlMock._quiet = [{ owner_channel: 'whatsapp', owner_chat_id: 'boss', owner_phone: null }];
    calls.length = 0; journal.length = 0;
    let delivered = false;
    setDeliver(async () => { delivered = true; return { ok: true }; });
    await tick(utc(2026, 6, 8, 4, 0));
    assert.equal(delivered, true, 'сторож игнорирует тихий режим');
    assert.equal(calls.find((c) => c[0] === 'markRun')[2], 'watch');
  });

  test('owner в quiet + обычная (не-watch) строка → молчит', async () => {
    // once без watch_task_id → обычное напоминание боссу, его тихий режим глушит.
    mysqlMock._rows = [watchRow({ watch_task_id: null, watch_goal: null, nag_interval_min: 0 })];
    mysqlMock._task = null;
    mysqlMock._quiet = [{ owner_channel: 'whatsapp', owner_chat_id: 'boss', owner_phone: null }];
    calls.length = 0; journal.length = 0;
    let delivered = false;
    setDeliver(async () => { delivered = true; return { ok: true }; });
    await tick(utc(2026, 6, 8, 4, 0));
    assert.equal(delivered, false, 'обычное напоминание уважает тихий режим');
    assert.equal(calls.find((c) => c[0] === 'claim'), undefined, 'строку даже не захватываем');
    mysqlMock._quiet = [];
  });
});

'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

// Мок mysql через подмену require (как в tests/dispatcher.test.js).
const calls = [];
const journal = [];
const mysqlMock = {
  listEnabledSchedules: async () => mysqlMock._rows,
  markScheduleRun: async (id, when, status, next, opts) => calls.push(['markRun', id, status, next, opts || {}]),
  touchScheduleStatus: async (id, status) => calls.push(['touch', id, status]),
  bumpScheduleFail: async (id, status) => calls.push(['bumpFail', id, status]),
  claimSchedule: async (id, expected) => { calls.push(['claim', id, expected]); return mysqlMock._claimResult; },
  updateSchedule: async (id, fields) => { calls.push(['update', id, fields]); return Object.keys(fields).length; },
  setScheduleNextRun: async (id, next) => calls.push(['setNext', id, next]),
  setScheduleEnabled: async (id, on) => calls.push(['setEnabled', id, on]),
  logScheduleRun: async (id, title, status, detail) => journal.push({ id, status, detail }),
  cleanupScheduleRuns: async () => 0,
  listActiveQuiet: async () => mysqlMock._quiet,
  _rows: [],
  _claimResult: true,
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
    let delivered;
    setDeliver(async (payload) => { delivered = payload; return { ok: true }; });
    await tick(utc(2026, 6, 8, 4, 0));
    assert.equal(delivered.messageOrigin, 'scheduled');
    const mark = calls.find((c) => c[0] === 'markRun');
    assert.deepEqual(mark.slice(0, 3), ['markRun', 1, 'ok']);
    assert.equal(mark[3], '2026-06-09 04:00:00'); // завтра 9:00 локально
  });

  test('тихий режим владельца → созревшее расписание держим (нет claim, нет доставки)', async () => {
    mysqlMock._rows = [row({ id: 7, kind: 'daily', at_hour: 9, at_minute: 0, next_run_at: '2026-06-08 04:00:00' })];
    mysqlMock._quiet = [{ owner_channel: 'whatsapp', owner_chat_id: 'a', owner_phone: '7707' }];
    calls.length = 0;
    let delivered = false;
    setDeliver(async () => { delivered = true; return { ok: true }; });
    await tick(utc(2026, 6, 8, 4, 0));
    assert.equal(delivered, false, 'в тихом режиме первым не пишем');
    assert.equal(calls.find((c) => c[0] === 'claim'), undefined, 'расписание не захватывается — держим до снятия тишины');
    mysqlMock._quiet = [];
  });

  test('успех once → markRun(next=null) + выключение (завершено)', async () => {
    mysqlMock._rows = [row({ id: 2, kind: 'once', run_at: '2026-06-08 04:00:00', next_run_at: '2026-06-08 04:00:00' })];
    calls.length = 0;
    setDeliver(async () => ({ ok: true }));
    await tick(utc(2026, 6, 8, 4, 0));
    assert.deepEqual(calls.find((c) => c[0] === 'markRun').slice(0, 4), ['markRun', 2, 'ok', null]);
    assert.deepEqual(calls.find((c) => c[0] === 'setEnabled'), ['setEnabled', 2, false]);
  });

  test('lock_busy → restore next_run_at (claim занулил) + touch → ретрай на следующем tick', async () => {
    mysqlMock._rows = [row({ id: 3, kind: 'daily', at_hour: 9, at_minute: 0, next_run_at: '2026-06-08 04:00:00' })];
    calls.length = 0;
    setDeliver(async () => ({ ok: false, reason: 'lock_busy' }));
    await tick(utc(2026, 6, 8, 4, 0));
    assert.deepEqual(calls, [
      ['claim', 3, '2026-06-08 04:00:00'],
      ['setNext', 3, '2026-06-08 04:00:00'], // прежний момент восстановлен
      ['touch', 3, 'lock_busy'],
    ]);
    // следующий tick через минуту — расписание всё ещё due и доставляется
    calls.length = 0;
    setDeliver(async () => ({ ok: true }));
    await tick(utc(2026, 6, 8, 4, 1));
    assert.equal(calls.find((c) => c[0] === 'markRun')[2], 'ok');
  });

  test('claim отказан (отменили/перенесли между снимком и запуском) → доставки нет', async () => {
    mysqlMock._rows = [row({ id: 21, kind: 'daily', at_hour: 9, at_minute: 0, next_run_at: '2026-06-08 04:00:00' })];
    calls.length = 0;
    mysqlMock._claimResult = false;
    let delivered = false;
    setDeliver(async () => { delivered = true; return { ok: true }; });
    await tick(utc(2026, 6, 8, 4, 0));
    mysqlMock._claimResult = true;
    assert.equal(delivered, false);
    assert.deepEqual(calls, [['claim', 21, '2026-06-08 04:00:00']]); // и никаких записей
  });

  test('agent_error у once → next_run_at восстановлен (остаётся due) + bumpFail', async () => {
    mysqlMock._rows = [row({ id: 22, kind: 'once', run_at: '2026-06-08 04:00:00', next_run_at: '2026-06-08 04:00:00' })];
    calls.length = 0;
    setDeliver(async () => ({ ok: false, reason: 'agent_error' }));
    await tick(utc(2026, 6, 8, 4, 0));
    assert.deepEqual(calls.find((c) => c[0] === 'setNext'), ['setNext', 22, '2026-06-08 04:00:00']);
    assert.deepEqual(calls.find((c) => c[0] === 'bumpFail'), ['bumpFail', 22, 'agent_error']);
  });

  test('оборванный claim (running, updated_at протух) → перевзвод; свежий running не трогаем', async () => {
    // свежий running (другой процесс прямо сейчас) — пропускаем
    mysqlMock._rows = [row({
      id: 23, kind: 'daily', at_hour: 9, at_minute: 0, next_run_at: null,
      last_status: 'running', updated_at: '2026-06-08 03:55:00',
    })];
    calls.length = 0;
    setDeliver(async () => ({ ok: true }));
    await tick(utc(2026, 6, 8, 4, 0)); // 5 мин < 15
    assert.deepEqual(calls, []);
    // протухший running (рестарт посреди прогона) — перевзводим
    mysqlMock._rows = [row({
      id: 24, kind: 'daily', at_hour: 9, at_minute: 0, next_run_at: null,
      last_status: 'running', updated_at: '2026-06-08 03:00:00',
    })];
    calls.length = 0;
    await tick(utc(2026, 6, 8, 4, 0)); // 60 мин > 15
    assert.deepEqual(calls, [['setNext', 24, '2026-06-09 04:00:00']]);
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

  test('backfill: завершённое legacy-once (есть last_run_at) → выключение + журнал auto_disabled', async () => {
    mysqlMock._rows = [row({ id: 9, kind: 'once', run_at: '2026-06-01 04:00:00', last_run_at: '2026-06-01 04:00:05', next_run_at: null })];
    calls.length = 0;
    journal.length = 0;
    setDeliver(async () => ({ ok: true }));
    await tick(utc(2026, 6, 8, 3, 0));
    assert.deepEqual(calls.find((c) => c[0] === 'setEnabled'), ['setEnabled', 9, false]);
    assert.equal(calls.find((c) => c[0] === 'markRun'), undefined);
    // автоотключение больше не молчит — history покажет причину
    assert.equal(journal.find((j) => j.id === 9).status, 'auto_disabled');
  });

  test('журнал: ok / lock_busy / missed пишутся в orch_schedule_runs', async () => {
    // ok
    mysqlMock._rows = [row({ id: 11, kind: 'daily', at_hour: 9, at_minute: 0, next_run_at: '2026-06-08 04:00:00' })];
    journal.length = 0;
    setDeliver(async () => ({ ok: true }));
    await tick(utc(2026, 6, 8, 4, 0));
    assert.equal(journal.find((j) => j.id === 11).status, 'ok');
    // lock_busy
    mysqlMock._rows = [row({ id: 12, kind: 'daily', at_hour: 9, at_minute: 0, next_run_at: '2026-06-08 04:00:00' })];
    journal.length = 0;
    setDeliver(async () => ({ ok: false, reason: 'lock_busy' }));
    await tick(utc(2026, 6, 8, 4, 0));
    assert.equal(journal.find((j) => j.id === 12).status, 'lock_busy');
    // missed (просрочка за окном catch-up)
    mysqlMock._rows = [row({ id: 13, kind: 'daily', at_hour: 9, at_minute: 0, next_run_at: '2026-06-08 04:00:00' })];
    journal.length = 0;
    setDeliver(async () => ({ ok: true }));
    await tick(utc(2026, 6, 8, 6, 30));
    const m = journal.find((j) => j.id === 13);
    assert.equal(m.status, 'missed');
    assert.match(m.detail, /опоздание/);
  });

  test('main + nag_interval_min: once НЕ выключается, взводится фаза nag (next = now+N)', async () => {
    mysqlMock._rows = [row({ id: 30, kind: 'once', run_at: '2026-06-08 04:00:00', next_run_at: '2026-06-08 04:00:00', nag_interval_min: 10 })];
    calls.length = 0; journal.length = 0;
    setDeliver(async () => ({ ok: true }));
    await tick(utc(2026, 6, 8, 4, 0));
    const mark = calls.find((c) => c[0] === 'markRun');
    assert.equal(mark[2], 'ok');
    assert.equal(mark[3], '2026-06-08 04:10:00'); // повтор через 10 мин
    assert.deepEqual(mark[4], { bumpRunCount: true, firePhase: 'nag', nagCount: 0 });
    assert.equal(calls.find((c) => c[0] === 'setEnabled'), undefined, 'once с будильником не выключается');
    assert.match(journal.find((j) => j.id === 30).detail, /будильник/);
  });

  test('nag: повтор доставлен → счётчик растёт, next = now+N; инструкция содержит acknowledge', async () => {
    mysqlMock._rows = [row({ id: 31, kind: 'once', run_at: '2026-06-08 04:00:00', last_run_at: '2026-06-08 04:00:00',
      next_run_at: '2026-06-08 04:10:00', fire_phase: 'nag', nag_interval_min: 10, nag_count: 1, nag_max: 3 })];
    calls.length = 0;
    let instr = '';
    setDeliver(async ({ instruction }) => { instr = instruction; return { ok: true }; });
    await tick(utc(2026, 6, 8, 4, 10));
    assert.match(instr, /ПОВТОР 2\/3/);
    assert.match(instr, /acknowledge/);
    const mark = calls.find((c) => c[0] === 'markRun');
    assert.equal(mark[2], 'nag');
    assert.equal(mark[3], '2026-06-08 04:20:00');
    assert.deepEqual(mark[4], { nagCount: 2 });
  });

  test('nag исчерпан (k>=max): once → выключение + nag_exhausted в журнале', async () => {
    mysqlMock._rows = [row({ id: 32, kind: 'once', run_at: '2026-06-08 04:00:00', last_run_at: '2026-06-08 04:00:00',
      next_run_at: '2026-06-08 04:30:00', fire_phase: 'nag', nag_interval_min: 10, nag_count: 2, nag_max: 3 })];
    calls.length = 0; journal.length = 0;
    setDeliver(async () => ({ ok: true }));
    await tick(utc(2026, 6, 8, 4, 30));
    assert.equal(calls.find((c) => c[0] === 'markRun')[2], 'nag_exhausted');
    assert.deepEqual(calls.find((c) => c[0] === 'setEnabled'), ['setEnabled', 32, false]);
    assert.equal(journal.find((j) => j.id === 32).status, 'nag_exhausted');
  });

  test('nag исчерпан у recurring → возврат к следующему вхождению (фаза main)', async () => {
    mysqlMock._rows = [row({ id: 33, kind: 'daily', at_hour: 9, at_minute: 0,
      next_run_at: '2026-06-08 04:30:00', fire_phase: 'nag', nag_interval_min: 10, nag_count: 2, nag_max: 3 })];
    calls.length = 0;
    setDeliver(async () => ({ ok: true }));
    await tick(utc(2026, 6, 8, 4, 30));
    const mark = calls.find((c) => c[0] === 'markRun');
    assert.equal(mark[2], 'nag_exhausted');
    assert.equal(mark[3], '2026-06-09 04:00:00'); // завтра 9:00 локально
    assert.deepEqual(mark[4], { firePhase: 'main', nagCount: 0 });
  });

  test('nag + lock_busy: счётчик НЕ растёт, момент восстановлен', async () => {
    mysqlMock._rows = [row({ id: 34, kind: 'once', run_at: '2026-06-08 04:00:00', last_run_at: '2026-06-08 04:00:00',
      next_run_at: '2026-06-08 04:10:00', fire_phase: 'nag', nag_interval_min: 10, nag_count: 1 })];
    calls.length = 0;
    setDeliver(async () => ({ ok: false, reason: 'lock_busy' }));
    await tick(utc(2026, 6, 8, 4, 10));
    assert.deepEqual(calls.find((c) => c[0] === 'setNext'), ['setNext', 34, '2026-06-08 04:10:00']);
    assert.equal(calls.find((c) => c[0] === 'markRun'), undefined);
  });

  test('nag после суточного простоя досылается (catch-up не применяется)', async () => {
    mysqlMock._rows = [row({ id: 35, kind: 'daily', at_hour: 9, at_minute: 0,
      next_run_at: '2026-06-07 04:10:00', fire_phase: 'nag', nag_interval_min: 10, nag_count: 0 })];
    calls.length = 0;
    let delivered = false;
    setDeliver(async () => { delivered = true; return { ok: true }; });
    await tick(utc(2026, 6, 8, 4, 10)); // сутки спустя
    assert.equal(delivered, true, 'будильник обязан дозвонить после рестарта');
  });

  test('pre: доставка → промоут в main с точным mainAt, last_run_at не трогается', async () => {
    mysqlMock._rows = [row({ id: 36, kind: 'once', run_at: '2026-06-08 04:00:00',
      next_run_at: '2026-06-08 03:30:00', fire_phase: 'pre', remind_before_min: 30 })];
    calls.length = 0; journal.length = 0;
    let instr = '';
    setDeliver(async ({ instruction }) => { instr = instruction; return { ok: true }; });
    await tick(utc(2026, 6, 8, 3, 30));
    assert.match(instr, /ПРЕД-НАПОМИНАНИЕ за 30 мин/);
    assert.deepEqual(calls.find((c) => c[0] === 'update'),
      ['update', 36, { fire_phase: 'main', next_run_at: '2026-06-08 04:00:00' }]);
    assert.equal(calls.find((c) => c[0] === 'markRun'), undefined, 'last_run_at не трогаем на pre');
    assert.equal(journal.find((j) => j.id === 36).status, 'pre_ok');
  });

  test('pre протух за main (бот лежал) → одно сообщение: сразу основной запуск', async () => {
    mysqlMock._rows = [row({ id: 37, kind: 'once', run_at: '2026-06-08 04:00:00',
      next_run_at: '2026-06-08 03:30:00', fire_phase: 'pre', remind_before_min: 30 })];
    calls.length = 0;
    const instrs = [];
    setDeliver(async ({ instruction }) => { instrs.push(instruction); return { ok: true }; });
    await tick(utc(2026, 6, 8, 4, 5)); // уже позже main
    assert.equal(instrs.length, 1);
    assert.match(instrs[0], /АВТО-ЗАДАЧА/); // основной, не пред-напоминание
    assert.equal(calls.find((c) => c[0] === 'markRun')[2], 'ok');
  });

  test('pre с ошибкой доставки → промоут в main всё равно (основной запуск в силе)', async () => {
    mysqlMock._rows = [row({ id: 38, kind: 'once', run_at: '2026-06-08 04:00:00',
      next_run_at: '2026-06-08 03:30:00', fire_phase: 'pre', remind_before_min: 30 })];
    calls.length = 0; journal.length = 0;
    setDeliver(async () => ({ ok: false, reason: 'agent_error' }));
    await tick(utc(2026, 6, 8, 3, 30));
    assert.deepEqual(calls.find((c) => c[0] === 'update'),
      ['update', 38, { fire_phase: 'main', next_run_at: '2026-06-08 04:00:00' }]);
    assert.equal(journal.find((j) => j.id === 38).status, 'pre_error');
  });

  test('recurring + max_runs достигнут → выключение + completed в журнале', async () => {
    mysqlMock._rows = [row({ id: 39, kind: 'daily', at_hour: 9, at_minute: 0,
      next_run_at: '2026-06-08 04:00:00', run_count: 2, max_runs: 3 })];
    calls.length = 0; journal.length = 0;
    setDeliver(async () => ({ ok: true }));
    await tick(utc(2026, 6, 8, 4, 0));
    const mark = calls.find((c) => c[0] === 'markRun');
    assert.equal(mark[3], null);
    assert.deepEqual(calls.find((c) => c[0] === 'setEnabled'), ['setEnabled', 39, false]);
    const j = journal.find((x) => x.id === 39);
    assert.equal(j.status, 'completed');
    assert.match(j.detail, /3 из 3/);
  });

  test('recurring + until истёк после этого запуска → выключение + completed (until)', async () => {
    mysqlMock._rows = [row({ id: 40, kind: 'daily', at_hour: 9, at_minute: 0,
      next_run_at: '2026-06-08 04:00:00', until_at: '2026-06-08 12:00:00' })];
    calls.length = 0; journal.length = 0;
    setDeliver(async () => ({ ok: true }));
    await tick(utc(2026, 6, 8, 4, 0)); // следующее было бы завтра — за границей until
    assert.deepEqual(calls.find((c) => c[0] === 'setEnabled'), ['setEnabled', 40, false]);
    assert.match(journal.find((x) => x.id === 40).detail, /until/);
  });

  test('recurring с remind_before: после ok следующая фаза — pre за N минут', async () => {
    mysqlMock._rows = [row({ id: 41, kind: 'daily', at_hour: 9, at_minute: 0,
      next_run_at: '2026-06-08 04:00:00', remind_before_min: 30 })];
    calls.length = 0;
    setDeliver(async () => ({ ok: true }));
    await tick(utc(2026, 6, 8, 4, 0));
    const mark = calls.find((c) => c[0] === 'markRun');
    assert.equal(mark[3], '2026-06-09 03:30:00'); // завтра 9:00 минус 30 мин
    assert.equal(mark[4].firePhase, 'pre');
  });

  test('rearm оборванного nag (next_run_at=NULL после рестарта) → повтор от «сейчас»', async () => {
    mysqlMock._rows = [row({ id: 42, kind: 'once', run_at: '2026-06-08 04:00:00', last_run_at: '2026-06-08 04:00:00',
      next_run_at: null, fire_phase: 'nag', nag_interval_min: 10, nag_count: 1, last_status: 'nag' })];
    calls.length = 0;
    setDeliver(async () => ({ ok: true }));
    await tick(utc(2026, 6, 8, 5, 0));
    assert.deepEqual(calls, [['setNext', 42, '2026-06-08 05:10:00']]);
  });

  test('running-гард: повторный tick во время незавершённого deliver не дублирует', async () => {
    mysqlMock._rows = [row({ id: 10, kind: 'daily', at_hour: 9, at_minute: 0, next_run_at: '2026-06-08 04:00:00' })];
    calls.length = 0;
    let resolveDeliver;
    setDeliver(() => new Promise((r) => { resolveDeliver = () => r({ ok: true }); }));
    const p1 = tick(utc(2026, 6, 8, 4, 0)); // зависнет на deliver
    await tick(utc(2026, 6, 8, 4, 0));      // должен выйти сразу (running=true)
    // первый tick доходит до deliver асинхронно (перед ним await claim)
    while (!resolveDeliver) await new Promise((r) => setImmediate(r));
    resolveDeliver();
    await p1;
    assert.equal(calls.filter((c) => c[0] === 'markRun').length, 1);
  });
});

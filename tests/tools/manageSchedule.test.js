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
  logScheduleRun: async (id, title, status, detail) => mysqlMock._journal.push({ id, status, detail }),
  _runs: [],
  _journal: [],
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
function reset() { created.length = 0; updates.length = 0; ownerRows = []; activeCount = 0; mysqlMock._journal.length = 0; }

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

  test('weekdays «0,6» (Вс≠0) / «Mon» / month_days «32» → ошибка create, мёртвая строка не вставляется', async () => {
    reset();
    const sunday0 = await handler({ action: 'create', title: 'X', instruction: 'y', kind: 'weekly', at_hour: 9, weekdays: '0,6' }, ctx);
    assert.equal(sunday0.success, false);
    assert.match(sunday0.message, /Вс=7|НЕ 0/);
    const named = await handler({ action: 'create', title: 'X', instruction: 'y', kind: 'weekly', at_hour: 9, weekdays: 'Mon,Wed' }, ctx);
    assert.equal(named.success, false);
    const day32 = await handler({ action: 'create', title: 'X', instruction: 'y', kind: 'monthly', at_hour: 9, month_days: '32' }, ctx);
    assert.equal(day32.success, false);
    assert.match(day32.message, /1–31/);
    assert.equal(created.length, 0, 'ни одна невалидная строка не ушла в БД');
    // валидные значения по-прежнему проходят
    const ok = await handler({ action: 'create', title: 'X', instruction: 'y', kind: 'weekly', at_hour: 9, weekdays: '1,3,5' }, ctx);
    assert.equal(ok.success, true);
  });

  test('update weekdays на невалидные → отклонено, расписание не изменено', async () => {
    reset();
    ownerRows = [owned({ id: 20, title: 'X', instruction: 'y', kind: 'weekly', at_hour: 9, at_minute: 0, weekdays: '1,3' })];
    const r = await handler({ action: 'update', id: 20, weekdays: '0,6' }, ctx);
    assert.equal(r.success, false);
    assert.equal(updates.length, 0);
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

describe('manage_schedule: будильник/календарь (create с новыми полями)', () => {
  test('once + nag + remind_before: создаётся с фазой pre, confirm описывает режим', async () => {
    reset();
    const r = await handler({
      action: 'create', title: 'Звонок', instruction: 'напомни про звонок', kind: 'once',
      run_at: '2030-01-01 10:00:00', nag_interval_min: 10, remind_before_min: 30,
    }, ctx);
    assert.equal(r.success, true);
    assert.equal(created[0].fire_phase, 'pre');
    assert.equal(created[0].next_run_at, '2030-01-01 04:30:00'); // 05:00 UTC − 30 мин
    assert.equal(created[0].nag_interval_min, 10);
    assert.match(r.confirm_to_boss, /предупрежу за 30 мин/);
    assert.match(r.confirm_to_boss, /каждые 10 мин/);
  });

  test('yearly: создаётся по MM-DD; кривая дата → ошибка', async () => {
    reset();
    const r = await handler({ action: 'create', title: 'ДР мамы', instruction: 'поздравь', kind: 'yearly', at_hour: 9, yearly_date: '03-14' }, ctx);
    assert.equal(r.success, true);
    assert.equal(created[0].yearly_date, '03-14');
    assert.match(r.when, /каждый год 14\.03/);
    const bad = await handler({ action: 'create', title: 'X', instruction: 'y', kind: 'yearly', at_hour: 9, yearly_date: '02-30' }, ctx);
    assert.equal(bad.success, false);
    assert.match(bad.message, /не бывает/);
  });

  test('until_date: прошлое → ошибка; once + until → ошибка; max_runs для once → ошибка', async () => {
    reset();
    const past = await handler({ action: 'create', title: 'X', instruction: 'y', kind: 'daily', at_hour: 9, until_date: '2020-01-01' }, ctx);
    assert.equal(past.success, false);
    assert.match(past.message, /прошлом/);
    const onceUntil = await handler({ action: 'create', title: 'X', instruction: 'y', kind: 'once', run_at: '2030-01-01 10:00:00', until_date: '2031-01-01' }, ctx);
    assert.equal(onceUntil.success, false);
    const onceMax = await handler({ action: 'create', title: 'X', instruction: 'y', kind: 'once', run_at: '2030-01-01 10:00:00', max_runs: 3 }, ctx);
    assert.equal(onceMax.success, false);
    // валидное until сохраняется как конец локального дня в UTC
    const ok = await handler({ action: 'create', title: 'X', instruction: 'y', kind: 'daily', at_hour: 9, until_date: '2030-06-13' }, ctx);
    assert.equal(ok.success, true);
    assert.equal(created[0].until_at, '2030-06-13 18:59:59'); // 23:59:59 локально − 5ч
  });

  test('nag_interval_min меньше минимума → ошибка', async () => {
    reset();
    const r = await handler({ action: 'create', title: 'X', instruction: 'y', kind: 'once', delay_minutes: 30, nag_interval_min: 1 }, ctx);
    assert.equal(r.success, false);
    assert.match(r.message, /nag_interval_min/);
  });
});

describe('manage_schedule: acknowledge', () => {
  test('без id при одном ждущем → once выключается, журнал acked', async () => {
    reset();
    ownerRows = [owned({ id: 30, title: 'Звонок', instruction: 'y', kind: 'once', run_at: '2026-06-08 05:00:00', fire_phase: 'nag', nag_count: 2 })];
    const r = await handler({ action: 'acknowledge' }, ctx);
    assert.equal(r.success, true);
    assert.equal(r.id, 30);
    const [, fields] = updates[0];
    assert.equal(fields.enabled, 0);
    assert.equal(fields.next_run_at, null);
    assert.equal(mysqlMock._journal[0].status, 'acked');
  });

  test('recurring → возврат к следующему вхождению (без выключения)', async () => {
    reset();
    ownerRows = [owned({ id: 31, title: 'Сводка', instruction: 'y', kind: 'daily', at_hour: 9, at_minute: 0, fire_phase: 'nag', nag_count: 1 })];
    const r = await handler({ action: 'acknowledge', id: 31 }, ctx);
    assert.equal(r.success, true);
    const [, fields] = updates[0];
    assert.equal(fields.fire_phase, 'main');
    assert.equal(fields.nag_count, 0);
    assert.match(String(fields.next_run_at), /^\d{4}-\d{2}-\d{2} /);
    assert.ok(r.next_run_local);
  });

  test('нет ждущих → понятный отказ; несколько → список и просьба указать id', async () => {
    reset();
    ownerRows = [owned({ id: 32, title: 'X', instruction: 'y', kind: 'daily', at_hour: 9, fire_phase: 'main' })];
    const none = await handler({ action: 'acknowledge' }, ctx);
    assert.equal(none.success, false);
    assert.match(none.message, /Нет напоминаний/);
    ownerRows = [
      owned({ id: 33, title: 'A', instruction: 'y', kind: 'once', run_at: '2026-06-08 05:00:00', fire_phase: 'nag' }),
      owned({ id: 34, title: 'B', instruction: 'y', kind: 'once', run_at: '2026-06-08 06:00:00', fire_phase: 'nag' }),
    ];
    const many = await handler({ action: 'acknowledge' }, ctx);
    assert.equal(many.success, false);
    assert.equal(many.waiting.length, 2);
  });

  test('id не в фазе nag → отказ «не ждёт подтверждения»', async () => {
    reset();
    ownerRows = [owned({ id: 35, title: 'X', instruction: 'y', kind: 'daily', at_hour: 9, fire_phase: 'main' })];
    const r = await handler({ action: 'acknowledge', id: 35 }, ctx);
    assert.equal(r.success, false);
    assert.match(r.message, /не ждёт подтверждения/);
  });
});

describe('manage_schedule: snooze', () => {
  test('двигает next_run_at на now+N, реанимирует выключенное, журнал snoozed', async () => {
    reset();
    // отгоревший once (enabled=0) — snooze возвращает к жизни
    ownerRows = [owned({ id: 40, title: 'X', instruction: 'y', kind: 'once', run_at: '2026-06-08 05:00:00', enabled: 0, last_run_at: null, fire_phase: 'main' })];
    const before = Date.now();
    const r = await handler({ action: 'snooze', id: 40, snooze_minutes: 15 }, ctx);
    assert.equal(r.success, true);
    const [, fields] = updates[0];
    assert.equal(fields.enabled, 1);
    assert.equal(fields.fail_count, 0);
    const next = new Date(String(fields.next_run_at).replace(' ', 'T') + 'Z').getTime();
    assert.ok(Math.abs(next - (before + 15 * 60000)) < 5000);
    assert.equal(mysqlMock._journal[0].status, 'snoozed');
  });

  test('без id: берёт ждущий подтверждения будильник; диапазон snooze_minutes', async () => {
    reset();
    ownerRows = [owned({ id: 41, title: 'X', instruction: 'y', kind: 'once', run_at: '2026-06-08 05:00:00', fire_phase: 'nag' })];
    const r = await handler({ action: 'snooze', snooze_minutes: 10 }, ctx);
    assert.equal(r.success, true);
    assert.equal(r.id, 41);
    assert.equal((await handler({ action: 'snooze', id: 41, snooze_minutes: 0 }, ctx)).success, false);
    assert.equal((await handler({ action: 'snooze', id: 41, snooze_minutes: 5000 }, ctx)).success, false);
  });
});

describe('manage_schedule: skip_next', () => {
  test('recurring: next_run_at = вхождение ПОСЛЕ ближайшего', async () => {
    reset();
    ownerRows = [owned({ id: 50, title: 'Сводка', instruction: 'y', kind: 'daily', at_hour: 9, at_minute: 0,
      fire_phase: 'main', next_run_at: '2030-06-10 04:00:00' })];
    const r = await handler({ action: 'skip_next', id: 50 }, ctx);
    assert.equal(r.success, true);
    assert.match(r.skipped_local, /2030-06-10 09:00/);
    const [, fields] = updates[0];
    assert.equal(fields.next_run_at, '2030-06-11 04:00:00'); // послезавтра 9:00 локально
  });

  test('once → ошибка; фаза nag → «сначала acknowledge»', async () => {
    reset();
    ownerRows = [
      owned({ id: 51, title: 'X', instruction: 'y', kind: 'once', run_at: '2030-01-01 05:00:00', next_run_at: '2030-01-01 05:00:00' }),
      owned({ id: 52, title: 'Y', instruction: 'y', kind: 'daily', at_hour: 9, fire_phase: 'nag', next_run_at: '2030-01-01 05:00:00' }),
    ];
    assert.match((await handler({ action: 'skip_next', id: 51 }, ctx)).message, /once/);
    assert.match((await handler({ action: 'skip_next', id: 52 }, ctx)).message, /acknowledge/);
  });
});

describe('manage_schedule: agenda', () => {
  test('сортировка по времени, горизонт today отсекает завтрашнее, time_left присутствует', async () => {
    reset();
    // «сейчас» в тесте — реальное время; берём далёкое будущее с заведомо разными датами
    const now = Date.now();
    const in2h = new Date(now + 2 * 3600000);
    const in30m = new Date(now + 30 * 60000);
    const fmt = (d) => d.toISOString().slice(0, 19).replace('T', ' ');
    ownerRows = [
      owned({ id: 60, title: 'Позже', instruction: 'y', kind: 'once', run_at: fmt(in2h), next_run_at: fmt(in2h), fire_phase: 'main' }),
      owned({ id: 61, title: 'Скоро', instruction: 'y', kind: 'once', run_at: fmt(in30m), next_run_at: fmt(in30m), fire_phase: 'main' }),
      owned({ id: 62, title: 'Через месяц', instruction: 'y', kind: 'once', run_at: '2099-01-01 05:00:00', next_run_at: '2099-01-01 05:00:00', fire_phase: 'main' }),
    ];
    const r = await handler({ action: 'agenda', horizon: 'week' }, ctx);
    assert.equal(r.success, true);
    assert.equal(r.count, 2, '2099 год не попадает в недельный горизонт');
    assert.equal(r.items[0].id, 61, 'ближайшее — первым');
    assert.match(r.items[0].time_left, /через/);
    const all = await handler({ action: 'agenda', horizon: 'all' }, ctx);
    assert.equal(all.count, 3);
  });

  test('пусто → понятная note', async () => {
    reset();
    ownerRows = [];
    const r = await handler({ action: 'agenda' }, ctx);
    assert.equal(r.success, true);
    assert.equal(r.count, 0);
    assert.match(r.note, /ничего не запланировано/);
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

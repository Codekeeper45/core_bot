'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { computeNextRunAt, toUtc, fmtUtc, csvHas } = require('../src/utils/scheduleTime');

// UTC helper: локальное (UTC+5) HH = UTC HH-5. Напр. 9:00 локально = 4:00 UTC.
const utc = (y, mo, d, h, mi = 0) => new Date(Date.UTC(y, mo - 1, d, h, mi));

describe('computeNextRunAt: once', () => {
  test('возвращает run_at как UTC', () => {
    const row = { kind: 'once', run_at: '2026-06-08 10:00:00', last_run_at: null };
    assert.equal(computeNextRunAt(row, utc(2026, 6, 1, 0, 0)).toISOString(), '2026-06-08T10:00:00.000Z');
  });
  test('run_at в прошлом всё равно возвращается (catch-up)', () => {
    const row = { kind: 'once', run_at: '2026-06-01 10:00:00', last_run_at: null };
    assert.equal(computeNextRunAt(row, utc(2026, 6, 8, 0, 0)).toISOString(), '2026-06-01T10:00:00.000Z');
  });
  test('уже выполненное once → null', () => {
    const row = { kind: 'once', run_at: '2026-06-01 10:00:00', last_run_at: '2026-06-01 10:00:05' };
    assert.equal(computeNextRunAt(row, utc(2026, 6, 8, 0, 0)), null);
  });
});

describe('computeNextRunAt: interval', () => {
  test('от from + interval_min (не немедленно)', () => {
    const row = { kind: 'interval', interval_min: 30 };
    assert.equal(computeNextRunAt(row, utc(2026, 6, 8, 9, 0)).toISOString(), '2026-06-08T09:30:00.000Z');
  });
  test('interval_min < 1 → null', () => {
    assert.equal(computeNextRunAt({ kind: 'interval', interval_min: 0 }, utc(2026, 6, 8, 9, 0)), null);
  });
});

describe('computeNextRunAt: daily', () => {
  test('сегодня, если локальное время ещё впереди', () => {
    // 9:00 локально = 4:00 UTC; сейчас 3:00 UTC (8:00 локально)
    const row = { kind: 'daily', at_hour: 9, at_minute: 0 };
    assert.equal(computeNextRunAt(row, utc(2026, 6, 8, 3, 0)).toISOString(), '2026-06-08T04:00:00.000Z');
  });
  test('завтра, если время уже прошло (или ровно сейчас)', () => {
    const row = { kind: 'daily', at_hour: 9, at_minute: 0 };
    assert.equal(computeNextRunAt(row, utc(2026, 6, 8, 4, 0)).toISOString(), '2026-06-09T04:00:00.000Z');
    assert.equal(computeNextRunAt(row, utc(2026, 6, 8, 5, 0)).toISOString(), '2026-06-09T04:00:00.000Z');
  });
  test('переход локальной даты: 23:00 локально при 20:00 UTC', () => {
    // 08.06 20:00 UTC = 09.06 01:00 локально → ближайшие 23:00 локально = 09.06 18:00 UTC
    const row = { kind: 'daily', at_hour: 23, at_minute: 0 };
    assert.equal(computeNextRunAt(row, utc(2026, 6, 8, 20, 0)).toISOString(), '2026-06-09T18:00:00.000Z');
  });
});

describe('computeNextRunAt: weekly', () => {
  test('ближайший указанный ISO-день', () => {
    // 08.06.2026 — понедельник. weekdays 3 (среда) → 10.06 в 9:00 локально = 4:00 UTC
    const row = { kind: 'weekly', at_hour: 9, at_minute: 0, weekdays: '3' };
    assert.equal(computeNextRunAt(row, utc(2026, 6, 8, 4, 0)).toISOString(), '2026-06-10T04:00:00.000Z');
  });
  test('сегодняшний день недели, если время впереди', () => {
    const row = { kind: 'weekly', at_hour: 9, at_minute: 0, weekdays: '1' }; // Пн
    assert.equal(computeNextRunAt(row, utc(2026, 6, 8, 3, 0)).toISOString(), '2026-06-08T04:00:00.000Z');
    // время прошло → следующий понедельник
    assert.equal(computeNextRunAt(row, utc(2026, 6, 8, 4, 0)).toISOString(), '2026-06-15T04:00:00.000Z');
  });
});

describe('computeNextRunAt: monthly', () => {
  test('ближайшее указанное число', () => {
    const row = { kind: 'monthly', at_hour: 9, at_minute: 0, month_days: '1,15' };
    assert.equal(computeNextRunAt(row, utc(2026, 6, 8, 4, 0)).toISOString(), '2026-06-15T04:00:00.000Z');
    // после 15-го → 1-е следующего месяца
    assert.equal(computeNextRunAt(row, utc(2026, 6, 16, 4, 0)).toISOString(), '2026-07-01T04:00:00.000Z');
  });
  test('31-е число перепрыгивает месяцы без 31-го', () => {
    const row = { kind: 'monthly', at_hour: 9, at_minute: 0, month_days: '31' };
    // июнь 2026 — 30 дней → ближайшее 31-е = 31 июля
    assert.equal(computeNextRunAt(row, utc(2026, 6, 1, 0, 0)).toISOString(), '2026-07-31T04:00:00.000Z');
  });
});

describe('toUtc / fmtUtc / csvHas', () => {
  test('toUtc трактует голую строку как UTC', () => {
    assert.equal(toUtc('2026-06-08 10:00:00').toISOString(), '2026-06-08T10:00:00.000Z');
    assert.equal(toUtc(new Date(Date.UTC(2026, 5, 8, 10))).toISOString(), '2026-06-08T10:00:00.000Z');
  });
  test('fmtUtc форматирует Date в YYYY-MM-DD HH:MM:SS', () => {
    assert.equal(fmtUtc(new Date(Date.UTC(2026, 5, 8, 4, 5, 6))), '2026-06-08 04:05:06');
  });
  test('csvHas находит число в CSV', () => {
    assert.equal(csvHas('1,3,5', 3), true);
    assert.equal(csvHas('1,3,5', 2), false);
    assert.equal(csvHas('', 1), false);
  });
});

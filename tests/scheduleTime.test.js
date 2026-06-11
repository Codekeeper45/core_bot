'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { computeNextRunAt, computeNextFire, fmtTimeLeft, toUtc, fmtUtc, csvHas } = require('../src/utils/scheduleTime');

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

describe('computeNextRunAt: yearly', () => {
  test('ближайшая дата MM-DD: в этом году, если впереди, иначе в следующем', () => {
    const row = { kind: 'yearly', at_hour: 9, at_minute: 0, yearly_date: '06-15' };
    assert.equal(computeNextRunAt(row, utc(2026, 6, 8, 4, 0)).toISOString(), '2026-06-15T04:00:00.000Z');
    assert.equal(computeNextRunAt(row, utc(2026, 6, 16, 4, 0)).toISOString(), '2027-06-15T04:00:00.000Z');
  });
  test('29.02: в невисокосный год срабатывает 28.02, в високосный — 29.02', () => {
    const row = { kind: 'yearly', at_hour: 9, at_minute: 0, yearly_date: '02-29' };
    // 2026 — невисокосный → 28.02.2026
    assert.equal(computeNextRunAt(row, utc(2025, 12, 1, 0, 0)).toISOString(), '2026-02-28T04:00:00.000Z');
    // после 28.02.2027 (невисокосный 2027 уже прошёл дату) → 29.02.2028 (високосный)
    assert.equal(computeNextRunAt(row, utc(2027, 3, 1, 0, 0)).toISOString(), '2028-02-29T04:00:00.000Z');
  });
  test('кривой yearly_date → null', () => {
    assert.equal(computeNextRunAt({ kind: 'yearly', at_hour: 9, yearly_date: '13-01' }, utc(2026, 6, 8, 0, 0)), null);
    assert.equal(computeNextRunAt({ kind: 'yearly', at_hour: 9, yearly_date: 'июнь' }, utc(2026, 6, 8, 0, 0)), null);
  });
});

describe('until_at: конец повторов', () => {
  test('daily: вхождение в пределах until (включительно) — есть, за пределами — null', () => {
    const row = { kind: 'daily', at_hour: 9, at_minute: 0, until_at: '2026-06-10 04:00:00' };
    assert.equal(computeNextRunAt(row, utc(2026, 6, 9, 5, 0)).toISOString(), '2026-06-10T04:00:00.000Z'); // ровно на границе — ок
    assert.equal(computeNextRunAt(row, utc(2026, 6, 10, 5, 0)), null); // следующее было бы 11-го — за границей
  });
  test('interval с until → null после границы', () => {
    const row = { kind: 'interval', interval_min: 30, until_at: '2026-06-08 09:15:00' };
    assert.equal(computeNextRunAt(row, utc(2026, 6, 8, 9, 0)), null); // next 9:30 > 9:15
  });
});

describe('computeNextFire (фаза pre/main)', () => {
  test('remind_before_min впереди → pre за N минут до main', () => {
    const row = { kind: 'once', run_at: '2026-06-08 10:00:00', last_run_at: null, remind_before_min: 30 };
    const f = computeNextFire(row, utc(2026, 6, 8, 9, 0));
    assert.equal(f.phase, 'pre');
    assert.equal(f.at.toISOString(), '2026-06-08T09:30:00.000Z');
  });
  test('момент pre уже прошёл (впритык) → сразу main', () => {
    const row = { kind: 'once', run_at: '2026-06-08 10:00:00', last_run_at: null, remind_before_min: 30 };
    const f = computeNextFire(row, utc(2026, 6, 8, 9, 45));
    assert.equal(f.phase, 'main');
    assert.equal(f.at.toISOString(), '2026-06-08T10:00:00.000Z');
  });
  test('без remind_before_min → main; нечего планировать → null', () => {
    const row = { kind: 'daily', at_hour: 9, at_minute: 0 };
    assert.equal(computeNextFire(row, utc(2026, 6, 8, 3, 0)).phase, 'main');
    assert.equal(computeNextFire({ kind: 'once', run_at: null, last_run_at: null }, utc(2026, 6, 8, 3, 0)), null);
  });
  test('свойство автомата: computeNextRunAt из момента pre даёт ровно main', () => {
    const row = { kind: 'daily', at_hour: 9, at_minute: 0, remind_before_min: 45 };
    const f = computeNextFire(row, utc(2026, 6, 8, 1, 0));
    assert.equal(f.phase, 'pre');
    assert.equal(computeNextRunAt(row, f.at).toISOString(), '2026-06-08T04:00:00.000Z');
  });
});

describe('fmtTimeLeft', () => {
  test('минуты / часы / дни / просрочка', () => {
    assert.equal(fmtTimeLeft(12 * 60000), 'через 12 мин');
    assert.equal(fmtTimeLeft(125 * 60000), 'через 2 ч 05 мин');
    assert.equal(fmtTimeLeft(2 * 60 * 60000), 'через 2 ч');
    assert.equal(fmtTimeLeft(76 * 60 * 60000), 'через 3 дн 4 ч');
    assert.equal(fmtTimeLeft(0), 'прямо сейчас');
    assert.equal(fmtTimeLeft(-10 * 60000), 'просрочено на 10 мин');
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

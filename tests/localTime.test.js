'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { systemTimestamp, localNow, isoWeekday } = require('../src/utils/localTime');

test('systemTimestamp: локальное время компании первым, UTC справочно', () => {
  // 10.06.2026 15:00 UTC = 20:00 локально (UTC+5)
  const s = systemTimestamp(new Date(Date.UTC(2026, 5, 10, 15, 0)), 300);
  assert.match(s, /сейчас 2026-06-10 20:00 по времени компании \(UTC\+5\)/);
  assert.match(s, /2026-06-10 15:00 UTC/);
});

test('systemTimestamp: переход через полночь (23:00 UTC = 04:00 следующего дня локально)', () => {
  const s = systemTimestamp(new Date(Date.UTC(2026, 5, 10, 23, 30)), 300);
  assert.match(s, /сейчас 2026-06-11 04:30 по времени компании/);
});

test('localNow/isoWeekday: сдвиг и ISO-день недели', () => {
  const utc = new Date(Date.UTC(2026, 5, 7, 20, 0)); // вс 20:00 UTC → пн 01:00 локально
  assert.equal(localNow(utc, 300).toISOString().slice(0, 13), '2026-06-08T01');
  assert.equal(isoWeekday(utc, 300), 1); // понедельник
});

'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { _internals } = require('../src/services/reportScheduler');

const { shouldFire, buildEveningReminders, buildMorningSummary, firstName } = _internals;

// SCHEDULER_TZ_OFFSET_MIN по умолчанию 300 (UTC+5): локальные 18:00 = 13:00 UTC.
const utc = (y, mo, d, h, mi = 0) => new Date(Date.UTC(y, mo - 1, d, h, mi));

test('shouldFire: стреляет один раз в нужный час', () => {
  const state = { evening: '', morning: '' };
  // Пн 08.06.2026, 18:03 локально (13:03 UTC)
  assert.strictEqual(shouldFire('evening', 18, utc(2026, 6, 8, 13, 3), state), true);
  // повторный тик в тот же час/день — не стреляет
  assert.strictEqual(shouldFire('evening', 18, utc(2026, 6, 8, 13, 4), state), false);
  // следующий день — снова стреляет
  assert.strictEqual(shouldFire('evening', 18, utc(2026, 6, 9, 13, 0), state), true);
});

test('shouldFire: не тот час и воскресенье — не стреляет', () => {
  const state = { evening: '', morning: '' };
  assert.strictEqual(shouldFire('evening', 18, utc(2026, 6, 8, 12, 59), state), false);
  // Вс 07.06.2026, 18:00 локально
  assert.strictEqual(shouldFire('evening', 18, utc(2026, 6, 7, 13, 0), state), false);
});

test('firstName: «Фамилия Имя» → имя, одиночное имя — как есть', () => {
  assert.strictEqual(firstName('Юрин Владимир'), 'Владимир');
  assert.strictEqual(firstName('Али'), 'Али');
});

test('buildEveningReminders: группирует по исполнителю, пропускает без задач и без контакта', () => {
  const employees = [
    { id: 1, name: 'Юрин Владимир', contact: '77001112233', channel: 'whatsapp' },
    { id: 2, name: 'Али', contact: '', channel: 'whatsapp' },        // нет контакта
    { id: 3, name: 'Ивлев Сергей', contact: '77004445566', channel: 'whatsapp' }, // нет задач
  ];
  const tasks = [
    { id: 10, title: 'Собрать лотки на Шабыт', status: 'in_progress', assignee_id: 1 },
    { id: 11, title: 'Зелёнка на Дрим Сити', status: 'dispatched', assignee_id: 1 },
    { id: 12, title: 'Пересчитать остаток', status: 'new', assignee_id: 2 },
  ];
  const out = buildEveningReminders(employees, tasks);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].employee.id, 1);
  assert.ok(out[0].text.startsWith('Владимир, конец дня'));
  assert.ok(out[0].text.includes('№10 «Собрать лотки на Шабыт» (в работе)'));
  assert.ok(out[0].text.includes('№11'));
  assert.ok(!out[0].text.includes('№12'));
});

test('buildMorningSummary: счётчики, блокеры и зависшие', () => {
  const now = utc(2026, 6, 10, 4); // 09:00 локально
  const employees = [
    { id: 1, name: 'Юрин Владимир' },
    { id: 2, name: 'Али' },
  ];
  const fourDaysAgo = new Date(now.getTime() - 4 * 24 * 3600 * 1000);
  const tasks = [
    { id: 10, title: 'Собрать лотки', status: 'in_progress', assignee_id: 1, updated_at: now },
    { id: 11, title: 'Найти газель', status: 'blocked', assignee_id: 2, updated_at: now },
    { id: 12, title: 'Закрыть документы', status: 'dispatched', assignee_id: 1, updated_at: fourDaysAgo },
  ];
  const text = buildMorningSummary(tasks, employees, now);
  assert.ok(text.includes('Открытых: 3 (в работе 1, ожидают 1, блокеры 1)'));
  assert.ok(text.includes('Блокеры:'));
  assert.ok(text.includes('№11 «Найти газель» — Али'));
  assert.ok(text.includes('Без движения'));
  assert.ok(text.includes('№12 «Закрыть документы» — Владимир (4 дн.)'));
});

test('buildMorningSummary: пусто и спокойно', () => {
  assert.strictEqual(buildMorningSummary([], []), 'Доброе утро. Открытых задач нет.');
  const now = new Date();
  const text = buildMorningSummary(
    [{ id: 1, title: 'Задача', status: 'in_progress', assignee_id: 1, updated_at: now }],
    [{ id: 1, name: 'Али' }], now
  );
  assert.ok(text.includes('Блокеров и зависших нет.'));
});

'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { _internals } = require('../src/services/reportScheduler');

const { shouldFire, buildEveningReminders, buildMorningSummary, firstName } = _internals;

// SCHEDULER_TZ_OFFSET_MIN по умолчанию 300 (UTC+5): локальные 18:00 = 13:00 UTC.
const utc = (y, mo, d, h, mi = 0) => new Date(Date.UTC(y, mo - 1, d, h, mi));

test('shouldFire: пора, если час наступил и сегодня ещё не слали', () => {
  // shouldFire без side-effect; «выполнено» помечает markDone (в коде — после успеха).
  // Пн 08.06.2026, 18:03 локально (13:03 UTC)
  assert.strictEqual(shouldFire('evening', 18, utc(2026, 6, 8, 13, 3), { evening: '' }), true);
  // уже слали сегодня (отметка стоит) — не стреляет
  assert.strictEqual(shouldFire('evening', 18, utc(2026, 6, 8, 13, 4), { evening: '2026-06-08' }), false);
  // следующий день — снова пора
  assert.strictEqual(shouldFire('evening', 18, utc(2026, 6, 9, 13, 0), { evening: '2026-06-08' }), true);
});

test('shouldFire: досыл при позднем старте, но не раньше часа и не в воскресенье', () => {
  // 20:00 локально, утреннюю в 9 ещё не слали → досылаем (час уже прошёл)
  assert.strictEqual(shouldFire('morning', 9, utc(2026, 6, 8, 15, 0), { morning: '' }), true);
  // 17:59 локально, вечерняя в 18 — рано
  assert.strictEqual(shouldFire('evening', 18, utc(2026, 6, 8, 12, 59), { evening: '' }), false);
  // Вс 07.06.2026, 18:00 локально — выходной
  assert.strictEqual(shouldFire('evening', 18, utc(2026, 6, 7, 13, 0), { evening: '' }), false);
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
  assert.ok(out[0].text.startsWith('Конец дня — отпишись по задачам:'));
  assert.ok(!out[0].text.includes('Владимир'));
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

test('buildMorningSummary: показывает сроки, отсутствие отчёта, загрузку и склад', () => {
  const now = utc(2026, 6, 10, 4);
  const tasks = [
    { id: 1, title: 'Просрочено', status: 'in_progress', assignee_id: 1,
      updated_at: now, deadline: utc(2026, 6, 9, 4), last_report_at: null },
    { id: 2, title: 'Сегодня', status: 'dispatched', assignee_id: 1,
      updated_at: now, deadline: utc(2026, 6, 10, 12), last_report_at: utc(2026, 6, 10, 3) },
  ];
  const text = buildMorningSummary(tasks, [{ id: 1, name: 'Юрин Владимир' }], now,
    [{ id: 5, name: 'Лоток DN100', qty: 10, reserved_qty: 10, available_qty: 0, unit: 'шт' }]);
  assert.match(text, /Просроченные:/);
  assert.match(text, /Срок сегодня:/);
  assert.match(text, /Без свежего отчёта:/);
  assert.match(text, /Загрузка:/);
  assert.match(text, /Склад:/);
});

test('buildGroupDailySummary: форматирует сводку сообщений группы склад отгрузки', () => {
  const { buildGroupDailySummary } = _internals;
  const messages = [
    { who: 'Иван', text: '[ГОЛОСОВОЕ | ОБЕЩАНИЕ/СРОК]\nТранскрипция: Обещал привезти 5 паллет к 15:00' },
    { who: 'Заиндин', text: '[ИЗОБРАЖЕНИЕ | НАКЛАДНАЯ/ДОКУМЕНТ]\nПодпись: нет\nОписание: Накладная №454, водитель Нурлан' },
    { who: 'Али', text: 'У нас задержка по доставке' },
  ];
  const summary = buildGroupDailySummary(messages, '2026-07-22', 'Склад отгрузки');
  assert.match(summary, /Ежедневная сводка по группе «Склад отгрузки»/);
  assert.match(summary, /Всего сообщений: 3/);
  assert.match(summary, /Иван, Заиндин, Али/);
  assert.match(summary, /Голосовые сообщения/);
  assert.match(summary, /Документы и накладные/);
  assert.match(summary, /Внимание \/ Задержки/);
});

'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

// Мок mysql через подмену require (паттерн tests/tools/manageSchedule.test.js).
let statsRows = [];
let captured = null;
const mysqlMock = {
  getEmployeePeriodStats: async (from, to) => { captured = { from, to }; return statsRows; },
};
const Module = require('module');
const orig = Module.prototype.require;
Module.prototype.require = function (id) {
  if (id === '../services/mysql') return mysqlMock;
  return orig.apply(this, arguments);
};
delete require.cache[require.resolve('../../src/tools/performanceReport')];
const { handler, definition, _internals } = require('../../src/tools/performanceReport');
Module.prototype.require = orig;

const { monthBoundsUtc, weakPoints, buildChart } = _internals;

describe('performance_report: границы месяца (локальный пояс UTC+5)', () => {
  const now = new Date(Date.UTC(2026, 5, 12, 10, 0)); // 12.06.2026 15:00 локально

  test('current: с 1-го числа локального месяца (UTC −5ч) по 1-е следующего', () => {
    const b = monthBoundsUtc('current', now);
    assert.equal(b.label, '2026-06');
    assert.equal(b.from.toISOString(), '2026-05-31T19:00:00.000Z'); // 01.06 00:00 локально
    assert.equal(b.to.toISOString(), '2026-06-30T19:00:00.000Z');
  });

  test('previous: прошлый месяц; явный YYYY-MM; переход через год', () => {
    assert.equal(monthBoundsUtc('previous', now).label, '2026-05');
    assert.equal(monthBoundsUtc('2026-01', now).label, '2026-01');
    // previous в январе → декабрь прошлого года
    const jan = new Date(Date.UTC(2026, 0, 15, 10, 0));
    assert.equal(monthBoundsUtc('previous', jan).label, '2025-12');
  });

  test('мусор в month → current по умолчанию', () => {
    assert.equal(monthBoundsUtc('июнь', now).label, '2026-06');
    assert.equal(monthBoundsUtc(undefined, now).label, '2026-06');
  });
});

describe('performance_report: проценты и слабые места', () => {
  test('handler: pct по каждому, totals, weak_points, график; idle отдельно', async () => {
    statsRows = [
      { id: 1, name: 'Курбан', roles: 'монтаж', assigned: 10, assigned_done: 9, done_total: 9, done_late: 0, open_overdue: 0, blocked_now: 0, avg_hours: 30 },
      { id: 2, name: 'Аслан', roles: 'снабжение', assigned: 8, assigned_done: 3, done_total: 4, done_late: 2, open_overdue: 3, blocked_now: 1, avg_hours: 70 },
      { id: 3, name: 'Мария', roles: 'офис', assigned: 0, assigned_done: 0, done_total: 0, done_late: 0, open_overdue: 0, blocked_now: 0, avg_hours: null },
    ];
    const r = await handler({ month: '2026-05' });
    assert.equal(r.success, true);
    assert.equal(r.month, '2026-05');
    assert.match(captured.from, /^2026-04-30 19:00:00$/);

    const kurban = r.employees.find((e) => e.name === 'Курбан');
    assert.equal(kurban.completion_pct, 90);
    assert.equal(kurban.avg_completion_days, 1.3);
    const aslan = r.employees.find((e) => e.name === 'Аслан');
    assert.equal(aslan.completion_pct, 38);

    assert.equal(r.totals.assigned, 18);
    assert.equal(r.totals.completion_pct, 67); // 12/18

    // слабые места: Аслан <60%, просрочки, блокеры, сдано позже срока
    assert.ok(r.weak_points.some((w) => /Аслан.*38%/.test(w)));
    assert.ok(r.weak_points.some((w) => /3 просроченных/.test(w)));
    assert.ok(r.weak_points.some((w) => /заблокировано/.test(w)));
    assert.ok(r.weak_points.some((w) => /позже дедлайна/.test(w)));
    // Курбан в слабые места не попал
    assert.ok(!r.weak_points.some((w) => /Курбан/.test(w)));

    // без задач → idle, не в основном списке
    assert.deepEqual(r.idle_employees, ['Мария']);
    assert.equal(r.employees.find((e) => e.name === 'Мария'), undefined);

    // график строится и содержит проценты
    assert.match(r.suggested_chart_mermaid, /^flowchart TD/);
    assert.match(r.suggested_chart_mermaid, /Курбан.*90%/);
  });

  test('пустой месяц → нет графика, нет слабых мест', async () => {
    statsRows = [{ id: 1, name: 'Курбан', roles: 'монтаж', assigned: 0, assigned_done: 0, done_total: 0, done_late: 0, open_overdue: 0, blocked_now: 0, avg_hours: null }];
    const r = await handler({});
    assert.equal(r.success, true);
    assert.equal(r.suggested_chart_mermaid, null);
    assert.deepEqual(r.weak_points, []);
    assert.equal(r.totals.completion_pct, null);
  });

  test('мало задач (<3) и низкий % → НЕ считается слабым местом (мало данных)', () => {
    const w = weakPoints([{ name: 'X', assigned: 2, assigned_done: 0, completion_pct: 0, done_late: 0, open_overdue: 0, blocked_now: 0 }]);
    assert.deepEqual(w, []);
  });

  test('definition: имя и enum-описание месяца', () => {
    assert.equal(definition.function.name, 'performance_report');
    assert.match(definition.function.parameters.properties.month.description, /previous/);
  });
});

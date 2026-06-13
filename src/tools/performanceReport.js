'use strict';
// Отчёт успеваемости по сотрудникам за месяц: проценты выполнения, просрочки,
// слабые места + готовая mermaid-диаграмма (для render_diagram). Режим босса (BOSS_ONLY).
// Все вычисления (границы месяца, проценты, выводы) делает код — LLM только пересказывает.
const { getEmployeePeriodStats } = require('../services/mysql');
const { fmtUtc } = require('../utils/scheduleTime');
const { handleToolDbError } = require('../utils/toolError');
const config = require('../config');

const definition = {
  type: 'function',
  function: {
    name: 'performance_report',
    description:
      'Отчёт успеваемости команды за месяц (режим босса): по каждому сотруднику — сколько задач '
      + 'поставлено, выполнено (в процентах), с опозданием, просрочено сейчас, заблокировано, '
      + 'среднее время выполнения. Код сам считает сильные (strong_points) и слабые места '
      + '(weak_points) и готовит '
      + 'mermaid-график (suggested_chart_mermaid) — отправь его боссу через render_diagram. '
      + 'Используй на «как успеваемость за месяц?», «итоги месяца», «кто отстаёт?» и в '
      + 'ежемесячном авто-отчёте.',
    parameters: {
      type: 'object',
      properties: {
        month: {
          type: 'string',
          description: 'Какой месяц: «current» (текущий, по сегодня), «previous» (прошлый, для '
            + 'итогов в начале месяца) или конкретный «YYYY-MM». По умолчанию current.',
        },
      },
      required: [],
    },
  },
};

// Границы месяца в локальном поясе → UTC. to не включается.
function monthBoundsUtc(arg, now = new Date()) {
  const offMs = config.SCHEDULER_TZ_OFFSET_MIN * 60000;
  const loc = new Date(now.getTime() + offMs);
  let y = loc.getUTCFullYear();
  let m = loc.getUTCMonth();
  if (arg === 'previous') m -= 1;
  else if (/^\d{4}-(0[1-9]|1[0-2])$/.test(String(arg || ''))) {
    y = Number(String(arg).slice(0, 4));
    m = Number(String(arg).slice(5, 7)) - 1;
  }
  const from = new Date(Date.UTC(y, m, 1) - offMs);
  const to = new Date(Date.UTC(y, m + 1, 1) - offMs);
  const label = new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 7);
  return { from, to, label };
}

const pct = (part, total) => (total > 0 ? Math.round((part / total) * 100) : null);

// Слабые места — детерминированные правила, чтобы выводы не «плавали» от запроса к запросу.
function weakPoints(rows) {
  const out = [];
  for (const r of rows) {
    if (r.assigned >= 3 && r.completion_pct !== null && r.completion_pct < 60) {
      out.push(`${r.name}: выполнено только ${r.completion_pct}% поставленных задач (${r.assigned_done} из ${r.assigned})`);
    }
    if (r.open_overdue > 0) out.push(`${r.name}: ${r.open_overdue} просроченных задач в работе`);
    if (r.blocked_now > 0) out.push(`${r.name}: ${r.blocked_now} задач заблокировано — нужно вмешательство`);
    if (r.done_late > 0) out.push(`${r.name}: ${r.done_late} задач сданы позже дедлайна`);
  }
  return out;
}

// Сильные стороны — зеркало weakPoints: отмечаем тех, кто реально тянет (нужна заметная
// выборка задач, чтобы похвала была заслуженной, а не от одной выполненной задачи).
function strongPoints(rows) {
  const out = [];
  for (const r of rows) {
    if (r.assigned >= 3 && r.completion_pct !== null && r.completion_pct >= 90) {
      out.push(`${r.name}: ${r.completion_pct}% выполнения (${r.assigned_done} из ${r.assigned}) — отличный результат`);
    }
    if (r.assigned_done >= 3 && r.done_late === 0 && r.open_overdue === 0 && r.blocked_now === 0) {
      out.push(`${r.name}: всё сдано в срок, без просрочек и блокеров`);
    }
    if (r.assigned_done >= 3 && r.avg_completion_days !== null && r.avg_completion_days <= 1) {
      out.push(`${r.name}: быстро закрывает задачи (в среднем ${r.avg_completion_days} дн)`);
    }
  }
  return out;
}

// Горизонтальная диаграмма «% выполнения по сотрудникам» (mermaid pie не подходит
// для сравнения людей; gantt/xychart в kroki ненадёжны → используем flowchart-карточки).
function buildChart(rows, label) {
  const bars = rows
    .filter((r) => r.assigned > 0)
    .map((r, i) => {
      const p = r.completion_pct ?? 0;
      const blocks = Math.round(p / 10);
      return `  e${i}["${r.name.replace(/"/g, '')} | ${'█'.repeat(blocks)}${'░'.repeat(10 - blocks)} ${p}% (${r.assigned_done}/${r.assigned})"]`;
    });
  if (!bars.length) return null;
  return `flowchart TD\n  t["Успеваемость за ${label}: % выполнения поставленных задач"]\n${bars.join('\n')}\n  t ~~~ e0`;
}

async function handler(args = {}) {
  try {
    const { from, to, label } = monthBoundsUtc(args.month);
    const stats = await getEmployeePeriodStats(fmtUtc(from), fmtUtc(to));
    const rows = stats.map((r) => ({
      id: r.id,
      name: r.name,
      roles: r.roles,
      assigned: Number(r.assigned) || 0,
      assigned_done: Number(r.assigned_done) || 0,
      completion_pct: pct(Number(r.assigned_done) || 0, Number(r.assigned) || 0),
      done_total: Number(r.done_total) || 0,
      done_late: Number(r.done_late) || 0,
      open_overdue: Number(r.open_overdue) || 0,
      blocked_now: Number(r.blocked_now) || 0,
      avg_completion_days: r.avg_hours != null ? Math.round((Number(r.avg_hours) / 24) * 10) / 10 : null,
    }));
    const totals = {
      assigned: rows.reduce((s, r) => s + r.assigned, 0),
      assigned_done: rows.reduce((s, r) => s + r.assigned_done, 0),
      done_total: rows.reduce((s, r) => s + r.done_total, 0),
      open_overdue: rows.reduce((s, r) => s + r.open_overdue, 0),
      blocked_now: rows.reduce((s, r) => s + r.blocked_now, 0),
    };
    totals.completion_pct = pct(totals.assigned_done, totals.assigned);
    const active = rows.filter((r) => r.assigned > 0 || r.done_total > 0 || r.open_overdue > 0 || r.blocked_now > 0);
    return {
      success: true,
      month: label,
      note: 'Все проценты, strong_points и weak_points уже посчитаны — пересказывай и сильные, '
        + 'и слабые стороны, не пересчитывай. '
        + 'График: вызови render_diagram с suggested_chart_mermaid (если не null).',
      totals,
      employees: active,
      idle_employees: rows.filter((r) => !active.includes(r)).map((r) => r.name),
      strong_points: strongPoints(rows),
      weak_points: weakPoints(rows),
      suggested_chart_mermaid: buildChart(rows, label),
    };
  } catch (err) {
    return handleToolDbError(err);
  }
}

module.exports = { definition, handler, _internals: { monthBoundsUtc, weakPoints, strongPoints, buildChart } };

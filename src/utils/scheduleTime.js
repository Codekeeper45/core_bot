'use strict';
// Вычисление времени запусков расписаний (orch_schedules) — общий код для
// scheduledRunner (когда стрелять следующий раз) и manage_schedule (next_run_at при
// create/update). Хранение и сравнение — в UTC; «человеческие» часы/дни недели/числа
// месяца — в локальном поясе компании (см. utils/localTime).
const config = require('../config');
const { localNow } = require('./localTime');

function csvHas(csv, value) {
  if (!csv) return false;
  return String(csv).split(',').map((s) => s.trim()).filter(Boolean).includes(String(value));
}

// DATETIME из БД → UTC Date. mysql2 отдаёт DATETIME как Date (пул сконфигурирован на UTC).
// «Голую» строку 'YYYY-MM-DD HH:MM:SS' трактуем как UTC (так мы её и храним).
function toUtc(v) {
  if (v instanceof Date) return v;
  const s = String(v);
  return new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s : s.replace(' ', 'T') + 'Z');
}

// Date → 'YYYY-MM-DD HH:MM:SS' (UTC) для записи в DATETIME.
function fmtUtc(d) {
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

const DAY_MS = 86400000;

// Следующий момент запуска (UTC Date) строго после from, либо null (нечего планировать).
// Чистая функция: не смотрит на «сейчас» кроме переданного from.
function computeNextRunAt(row, from = new Date(), tzOffsetMin) {
  const off = (tzOffsetMin === undefined) ? config.SCHEDULER_TZ_OFFSET_MIN : tzOffsetMin;
  switch (row.kind) {
    case 'once':
      if (row.last_run_at || !row.run_at) return null;
      return toUtc(row.run_at);
    case 'interval': {
      const min = Number(row.interval_min) || 0;
      if (min < 1) return null;
      return new Date(from.getTime() + min * 60000);
    }
    case 'daily':
    case 'weekly':
    case 'monthly': {
      const h = Number(row.at_hour);
      const m = Number(row.at_minute) || 0;
      if (!Number.isInteger(h)) return null;
      const loc = localNow(from, off); // сдвинутый Date, читаем UTC-геттерами
      const base = Date.UTC(loc.getUTCFullYear(), loc.getUTCMonth(), loc.getUTCDate(), h, m, 0);
      // Перебор дней вперёд (≤ 366 хватает для monthly с «31»): первый подходящий
      // локальный день, чьё время строго позже from.
      for (let i = 0; i <= 366; i++) {
        const cand = new Date(base + i * DAY_MS);
        if (cand.getTime() <= loc.getTime()) continue;
        if (row.kind === 'weekly') {
          const wd = cand.getUTCDay() === 0 ? 7 : cand.getUTCDay();
          if (!csvHas(row.weekdays, wd)) continue;
        }
        if (row.kind === 'monthly' && !csvHas(row.month_days, cand.getUTCDate())) continue;
        return new Date(cand.getTime() - off * 60000); // локальное → UTC
      }
      return null;
    }
    default:
      return null;
  }
}

module.exports = { computeNextRunAt, toUtc, fmtUtc, csvHas };

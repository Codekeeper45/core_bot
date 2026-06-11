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

// until_at: повторы закончились, если вычисленный момент позже конца (включительно).
function pastUntil(row, d) {
  return !!(d && row.until_at && d.getTime() > toUtc(row.until_at).getTime());
}

// 'MM-DD' для yearly: совпадение локального дня-кандидата с датой. 29.02 в
// невисокосный год нормализуется на 28.02 (иначе день рождения молча пропадёт).
function yearlyMatches(yearlyDate, cand) {
  const m = String(yearlyDate || '').match(/^(\d{2})-(\d{2})$/);
  if (!m) return false;
  const mo = Number(m[1]), day = Number(m[2]);
  if (cand.getUTCMonth() + 1 !== mo) return false;
  if (cand.getUTCDate() === day) return true;
  // 29 февраля → 28 февраля в невисокосный год (29-го в переборе просто не будет)
  if (mo === 2 && day === 29 && cand.getUTCDate() === 28) {
    const y = cand.getUTCFullYear();
    const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
    return !leap;
  }
  return false;
}

// Следующий момент ОСНОВНОГО запуска (UTC Date) строго после from, либо null
// (нечего планировать / повторы исчерпаны по until_at).
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
      const next = new Date(from.getTime() + min * 60000);
      return pastUntil(row, next) ? null : next;
    }
    case 'daily':
    case 'weekly':
    case 'monthly':
    case 'yearly': {
      const h = Number(row.at_hour);
      const m = Number(row.at_minute) || 0;
      if (!Number.isInteger(h)) return null;
      const loc = localNow(from, off); // сдвинутый Date, читаем UTC-геттерами
      const base = Date.UTC(loc.getUTCFullYear(), loc.getUTCMonth(), loc.getUTCDate(), h, m, 0);
      // Перебор дней вперёд: первый подходящий локальный день, чьё время строго
      // позже from. 366 хватает для monthly с «31»; yearly требует до 4 лет
      // (29.02 должно дожить до високосного года) — 1466 дней.
      const horizon = row.kind === 'yearly' ? 1466 : 366;
      for (let i = 0; i <= horizon; i++) {
        const cand = new Date(base + i * DAY_MS);
        if (cand.getTime() <= loc.getTime()) continue;
        if (row.kind === 'weekly') {
          const wd = cand.getUTCDay() === 0 ? 7 : cand.getUTCDay();
          if (!csvHas(row.weekdays, wd)) continue;
        }
        if (row.kind === 'monthly' && !csvHas(row.month_days, cand.getUTCDate())) continue;
        if (row.kind === 'yearly' && !yearlyMatches(row.yearly_date, cand)) continue;
        const next = new Date(cand.getTime() - off * 60000); // локальное → UTC
        return pastUntil(row, next) ? null : next;
      }
      return null;
    }
    default:
      return null;
  }
}

// Ближайшее СОБЫТИЕ автомата фаз: пред-напоминание (pre), если оно задано и ещё
// впереди, иначе основной запуск (main). null — планировать нечего.
// Свойство: из момента pre `computeNextRunAt(row, preAt)` возвращает ровно тот же
// main — его не нужно хранить отдельно.
function computeNextFire(row, from = new Date(), tzOffsetMin) {
  const main = computeNextRunAt(row, from, tzOffsetMin);
  if (!main) return null;
  const before = Number(row.remind_before_min) || 0;
  if (before > 0) {
    const pre = new Date(main.getTime() - before * 60000);
    if (pre.getTime() > from.getTime()) return { at: pre, phase: 'pre' };
  }
  return { at: main, phase: 'main' };
}

// «Через сколько» человеком: для list/agenda, чтобы LLM не считал время сам.
function fmtTimeLeft(ms) {
  if (ms <= 0) {
    const late = Math.round(-ms / 60000);
    return late < 1 ? 'прямо сейчас' : `просрочено на ${late} мин`;
  }
  const min = Math.round(ms / 60000);
  if (min < 60) return `через ${min} мин`;
  if (min < 1440) {
    const h = Math.floor(min / 60), m = min % 60;
    return m ? `через ${h} ч ${String(m).padStart(2, '0')} мин` : `через ${h} ч`;
  }
  const d = Math.floor(min / 1440), h = Math.floor((min % 1440) / 60);
  return h ? `через ${d} дн ${h} ч` : `через ${d} дн`;
}

module.exports = { computeNextRunAt, computeNextFire, fmtTimeLeft, toUtc, fmtUtc, csvHas };

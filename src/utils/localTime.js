'use strict';
// Локальное время компании (Казахстан, UTC+5 по умолчанию) поверх UTC-таймстампов.
// Используется планировщиками (reportScheduler, scheduledRunner): сравнивать «час/минуту/день»
// в локальном поясе, а не в UTC. Реализация через сдвиг + UTC-геттеры — без зависимостей от
// серверной TZ процесса.
const config = require('../config');

function localNow(now = new Date(), tzOffsetMin) {
  const off = (tzOffsetMin === undefined) ? config.SCHEDULER_TZ_OFFSET_MIN : tzOffsetMin;
  return new Date(now.getTime() + off * 60000);
}

// Дата YYYY-MM-DD в локальном поясе.
function localDateKey(now = new Date(), tzOffsetMin) {
  return localNow(now, tzOffsetMin).toISOString().slice(0, 10);
}

// ISO день недели: Пн=1 .. Вс=7 (в локальном поясе).
function isoWeekday(now = new Date(), tzOffsetMin) {
  const d = localNow(now, tzOffsetMin).getUTCDay(); // 0=Вс..6=Сб
  return d === 0 ? 7 : d;
}

// Системный штамп «сейчас» для каждого сообщения агенту: ЛОКАЛЬНОЕ время компании
// первым (LLM использует его для сроков/расписаний без арифметики поясов), UTC — справочно.
function systemTimestamp(now = new Date(), tzOffsetMin) {
  const off = (tzOffsetMin === undefined) ? config.SCHEDULER_TZ_OFFSET_MIN : tzOffsetMin;
  const fmt = (d) => d.toISOString().slice(0, 16).replace('T', ' ');
  return `[СИСТЕМА: сейчас ${fmt(localNow(now, off))} по времени компании (UTC+${off / 60}); ${fmt(now)} UTC]`;
}

// «ГГГГ-ММ-ДД ЧЧ:ММ» в локальном поясе компании для любой даты/строки/таймстампа.
// Используется при рендере чанков архива, чтобы бот видел точное время сообщения.
function localStamp(value, tzOffsetMin) {
  if (value == null || value === '') return '';
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return String(value).slice(0, 16);
  return localNow(d, tzOffsetMin).toISOString().slice(0, 16).replace('T', ' ');
}

// Перевод ЛОКАЛЬНОЙ (по времени компании) границы периода в абсолютный UTC-момент.
// Принимает 'ГГГГ-ММ-ДД' или 'ГГГГ-ММ-ДД ЧЧ:ММ[:СС]' (трактуется как местное время),
// либо строку с явным Z/смещением (трактуется как абсолютная). end=true достраивает
// «конец» периода по точности ввода: дата → 23:59:59.999, дата+минуты → :59.999.
// Возвращает Date (UTC) или null, если разобрать не удалось.
function localBoundaryToUtc(value, end = false, tzOffsetMin) {
  if (value == null || value === '') return null;
  const s = String(value).trim();
  // Явный пояс (Z или ±HH:MM) — абсолютный момент.
  if (/[zZ]$|[+-]\d{2}:?\d{2}$/.test(s)) {
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/);
  if (!m) {
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const [, y, mo, d, h, mi, sec] = m;
  const hasTime = h !== undefined;
  const hasSec = sec !== undefined;
  let H = h ? Number(h) : (end && !hasTime ? 23 : 0);
  let M = mi ? Number(mi) : (end && !hasTime ? 59 : 0);
  let S = sec ? Number(sec) : (end && !hasSec ? 59 : 0);
  let MS = end ? 999 : 0;
  // Компоненты — местные; собираем как UTC и вычитаем смещение пояса.
  const off = (tzOffsetMin === undefined) ? config.SCHEDULER_TZ_OFFSET_MIN : tzOffsetMin;
  const asUtc = Date.UTC(Number(y), Number(mo) - 1, Number(d), H, M, S, MS);
  return new Date(asUtc - off * 60000);
}

module.exports = { localNow, localDateKey, isoWeekday, systemTimestamp, localStamp, localBoundaryToUtc };

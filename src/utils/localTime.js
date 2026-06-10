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

module.exports = { localNow, localDateKey, isoWeekday, systemTimestamp };

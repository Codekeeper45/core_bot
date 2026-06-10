'use strict';
// Движок отложенных/регулярных действий, которые ИИ планирует сам (manage_schedule).
// Раз в минуту проверяет orch_schedules и для каждого «созревшего» расписания запускает
// инструкцию через обычный агентный цикл (инъектированный deliver из index.js).
//
// Время — локальное (UTC+5) для recurring; once.run_at — абсолютный UTC.
// Состояние (last_run_at) — в БД, переживает рестарт. Дедуп — по локальной минуте.
const {
  listEnabledSchedules, markScheduleRun, touchScheduleStatus, bumpScheduleFail,
} = require('./mysql');
const { localNow, isoWeekday } = require('../utils/localTime');

function csvHas(csv, value) {
  if (!csv) return false;
  return String(csv).split(',').map((s) => s.trim()).filter(Boolean).includes(String(value));
}

// DATETIME из БД → UTC Date. mysql2 отдаёт DATETIME как Date (сервер в UTC — как уже
// предполагает остальной код: daily-counts/reportScheduler через toISOString). «Голую»
// строку 'YYYY-MM-DD HH:MM:SS' трактуем как UTC (так мы её и храним).
function toUtc(v) {
  if (v instanceof Date) return v;
  const s = String(v);
  return new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s : s.replace(' ', 'T') + 'Z');
}

// Совпадает ли last_run_at с текущей локальной минутой (дедуп — не стрелять дважды в минуту).
function sameLocalMinute(lastRunAt, now) {
  if (!lastRunAt) return false;
  const a = localNow(toUtc(lastRunAt));
  const b = localNow(now);
  return a.toISOString().slice(0, 16) === b.toISOString().slice(0, 16);
}

// Пора ли запускать расписание прямо сейчас. Чистая функция.
function isDue(row, now = new Date()) {
  if (!row || !row.enabled) return false;
  switch (row.kind) {
    case 'once':
      return !row.last_run_at && !!row.run_at && toUtc(row.run_at) <= now;
    case 'interval': {
      const ms = (Number(row.interval_min) || 0) * 60000;
      if (ms <= 0) return false;
      return !row.last_run_at || (now.getTime() - toUtc(row.last_run_at).getTime()) >= ms;
    }
    case 'daily':
    case 'weekly':
    case 'monthly': {
      const loc = localNow(now);
      if (loc.getUTCHours() !== Number(row.at_hour)) return false;
      if (loc.getUTCMinutes() !== (Number(row.at_minute) || 0)) return false;
      if (row.kind === 'weekly' && !csvHas(row.weekdays, isoWeekday(now))) return false;
      if (row.kind === 'monthly' && !csvHas(row.month_days, loc.getUTCDate())) return false;
      return !sameLocalMinute(row.last_run_at, now);
    }
    default:
      return false;
  }
}

function wrapInstruction(title, instruction) {
  return `[АВТО-ЗАДАЧА ПО РАСПИСАНИЮ «${title}»]\n${instruction}`;
}

let deliverFn = null;   // инъекция из index.js (deliverInstruction)
let timer = null;
let running = false;     // гард: одно исполнение tick за раз (агентный цикл долгий)

// Выполнить одно расписание. Возвращает строку-статус для записи.
async function runSchedule(row, now) {
  const res = await deliverFn({
    channel: row.owner_channel,
    chatId: row.owner_chat_id,
    phone: row.owner_phone,
    clientName: 'boss',
    instruction: wrapInstruction(row.title, row.instruction),
    title: row.title,
  });

  if (res && res.ok) {
    await markScheduleRun(row.id, now, 'ok');
    return 'ok';
  }
  if (res && res.reason === 'lock_busy') {
    // Чат владельца занят (босс пишет прямо сейчас) — не теряем, повторим на следующем tick.
    await touchScheduleStatus(row.id, 'lock_busy');
    return 'lock_busy';
  }
  // Ошибка агентного цикла. Для once — копим fail_count (досыл, но не вечно);
  // для recurring — отмечаем выполненным, чтобы не спамить ретраями каждую минуту.
  const status = (res && res.reason) || 'agent_error';
  if (row.kind === 'once') await bumpScheduleFail(row.id, status);
  else await markScheduleRun(row.id, now, status);
  return status;
}

async function tick(now = new Date()) {
  if (running) return;
  running = true;
  try {
    const rows = await listEnabledSchedules();
    for (const row of rows) {
      if (!isDue(row, now)) continue;
      try {
        await runSchedule(row, now);
      } catch (e) {
        console.error(`[SchedRunner] schedule #${row.id}:`, e.message);
      }
    }
  } catch (err) {
    console.error('[SchedRunner] tick:', err.message);
  } finally {
    running = false;
  }
}

function start({ deliver } = {}) {
  if (typeof deliver !== 'function') {
    console.error('[SchedRunner] start: deliver не передан — планировщик действий не запущен');
    return;
  }
  deliverFn = deliver;
  if (timer) return;
  timer = setInterval(tick, 60 * 1000);
  if (timer.unref) timer.unref();
  console.log('[SchedRunner] Включён: проверка расписаний раз в минуту');
}

module.exports = {
  start,
  // для тестов
  _internals: { isDue, sameLocalMinute, csvHas, wrapInstruction, tick, runSchedule, setDeliver: (f) => { deliverFn = f; } },
};

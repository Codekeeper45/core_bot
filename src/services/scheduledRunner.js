'use strict';
// Движок отложенных/регулярных действий, которые ИИ планирует сам (manage_schedule).
// Раз в минуту проверяет orch_schedules и для каждого «созревшего» расписания запускает
// инструкцию через обычный агентный цикл (инъектированный deliver из index.js).
//
// Модель next_run_at: момент следующего запуска предвычислен и лежит в БД (UTC).
// Due = next_run_at <= now → опоздавший tick (долгий агентный прогон, рестарт, деплой)
// всё равно увидит созревшую задачу — пропусков «мимо минуты» нет. После запуска
// next_run_at пересчитывается (utils/scheduleTime). lock_busy не двигает next_run_at,
// поэтому ретраится каждый tick до успеха. Для daily/weekly/monthly есть окно catch-up
// (SCHEDULE_CATCHUP_WINDOW_MIN): сильно протухший запуск помечается missed и переносится,
// once досылается всегда.
const {
  listEnabledSchedules, markScheduleRun, touchScheduleStatus, bumpScheduleFail,
  setScheduleNextRun, setScheduleEnabled, logScheduleRun, cleanupScheduleRuns,
} = require('./mysql');
const { computeNextRunAt, toUtc, fmtUtc } = require('../utils/scheduleTime');
const config = require('../config');

const RECURRING_FIXED = ['daily', 'weekly', 'monthly'];

// Пора ли запускать расписание прямо сейчас. Чистая функция.
function isDue(row, now = new Date()) {
  if (!row || !row.enabled || !row.next_run_at) return false;
  return toUtc(row.next_run_at).getTime() <= now.getTime();
}

function wrapInstruction(title, instruction) {
  return `[АВТО-ЗАДАЧА ПО РАСПИСАНИЮ «${title}»]\n${instruction}`;
}

// Следующий next_run_at строкой для БД (или null, если планировать нечего).
function nextFor(row, now) {
  const d = computeNextRunAt(row, now);
  return d ? fmtUtc(d) : null;
}

let deliverFn = null;   // инъекция из index.js (deliverInstruction)
let timer = null;
let running = false;     // гард: одно исполнение tick за раз (агентный цикл долгий)
let lastCleanupDay = ''; // журнал чистим раз в сутки (старше 90 дней)

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

  const isOnce = row.kind === 'once';
  if (res && res.ok) {
    await markScheduleRun(row.id, now, 'ok', isOnce ? null : nextFor(row, now));
    if (isOnce) await setScheduleEnabled(row.id, false); // завершено — больше не опрашиваем
    await logScheduleRun(row.id, row.title, 'ok', null);
    return 'ok';
  }
  if (res && res.reason === 'lock_busy') {
    // Чат владельца занят (босс пишет прямо сейчас). next_run_at не трогаем —
    // расписание остаётся due и повторится на следующем tick (в т.ч. daily).
    await touchScheduleStatus(row.id, 'lock_busy');
    await logScheduleRun(row.id, row.title, 'lock_busy', 'чат занят, повтор на следующем tick');
    return 'lock_busy';
  }
  // Ошибка агентного цикла. Для once — копим fail_count (ретрай каждый tick, cutoff в БД);
  // для recurring — переносим на следующий раз, чтобы не спамить ретраями каждую минуту.
  const status = (res && res.reason) || 'agent_error';
  if (isOnce) await bumpScheduleFail(row.id, status);
  else await markScheduleRun(row.id, now, status, nextFor(row, now));
  await logScheduleRun(row.id, row.title, status, isOnce ? 'once: ретрай, после 3 неудач отключится' : 'перенесено на следующий раз');
  return status;
}

// Строка без next_run_at (legacy до миграции или ручная правка в БД): дозаполнить.
// Завершённое once реанимировать нечем — выключаем, чтобы не опрашивать вечно.
async function rearmSchedule(row, now) {
  const next = nextFor(row, now);
  if (next) await setScheduleNextRun(row.id, next);
  else await setScheduleEnabled(row.id, false);
}

async function tick(now = new Date()) {
  if (running) return;
  running = true;
  try {
    // Автоочистка журнала запусков — раз в сутки, не на каждом tick.
    const day = now.toISOString().slice(0, 10);
    if (day !== lastCleanupDay) {
      lastCleanupDay = day;
      cleanupScheduleRuns(90).catch(() => {});
    }

    const rows = await listEnabledSchedules();
    for (const row of rows) {
      try {
        if (!row.next_run_at) { await rearmSchedule(row, now); continue; }
        if (!isDue(row, now)) continue;
        // Сильно протухший фиксированный recurring (простой дольше окна) — missed,
        // переносим: дневная сводка в 18:00 уже не нужна. once досылаем всегда.
        if (RECURRING_FIXED.includes(row.kind)) {
          const lateMs = now.getTime() - toUtc(row.next_run_at).getTime();
          if (lateMs > config.SCHEDULE_CATCHUP_WINDOW_MIN * 60000) {
            await markScheduleRun(row.id, now, 'missed', nextFor(row, now));
            await logScheduleRun(row.id, row.title, 'missed',
              `опоздание ${Math.round(lateMs / 60000)} мин > окна ${config.SCHEDULE_CATCHUP_WINDOW_MIN} мин`);
            continue;
          }
        }
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
  console.log('[SchedRunner] Включён: проверка расписаний раз в минуту (модель next_run_at)');
}

module.exports = {
  start,
  // для тестов
  _internals: { isDue, wrapInstruction, tick, runSchedule, setDeliver: (f) => { deliverFn = f; } },
};

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
  claimSchedule, setScheduleNextRun, setScheduleEnabled, updateSchedule,
  logScheduleRun, cleanupScheduleRuns, listActiveQuiet,
  getTask, getEmployeeById,
} = require('./mysql');
const { computeNextRunAt, computeNextFire, toUtc, fmtUtc } = require('../utils/scheduleTime');
const config = require('../config');

const RECURRING_FIXED = ['daily', 'weekly', 'monthly', 'yearly'];

// Пора ли запускать расписание прямо сейчас. Чистая функция.
function isDue(row, now = new Date()) {
  if (!row || !row.enabled || !row.next_run_at) return false;
  return toUtc(row.next_run_at).getTime() <= now.getTime();
}

function wrapInstruction(title, instruction) {
  return `[АВТО-ЗАДАЧА ПО РАСПИСАНИЮ «${title}»]\n${instruction}`;
}

function wrapPre(row) {
  return `[ПРЕД-НАПОМИНАНИЕ за ${row.remind_before_min} мин до «${row.title}» (#${row.id})]\n${row.instruction}\n\n`
    + 'Это раннее предупреждение: основное напоминание придёт в срок. '
    + 'Кратко предупреди босса, что событие приближается.';
}

function wrapNag(row, k, max, nagN) {
  return `[ПОВТОР ${k}/${max} НАПОМИНАНИЯ «${row.title}» (#${row.id})]\n${row.instruction}\n\n`
    + `Это будильник: повтор приходит каждые ${nagN} мин, пока босс не подтвердит. `
    + `Если в недавней переписке босс УЖЕ подтвердил/ответил по этой теме («ок», «понял», «сделал») — `
    + `НЕ повторяй напоминание, а вызови manage_schedule {action:"acknowledge", id:${row.id}} и сообщи, что снял его. `
    + `Иначе напомни ещё раз и добавь в конец: «(повторю через ${nagN} мин — ответьте „ок“, чтобы я перестал)».`;
}

// ── Сторож исполнения (watchdog) ────────────────────────────────────────────
// Цель достигнута? accepted = сотрудник взял задачу в работу (статус ушёл с todo/
// dispatched); done = отчитался/сдал. Чистая функция.
const ACCEPTED_STATUSES = ['in_progress', 'blocked', 'done'];
function isGoalMet(goal, status) {
  if (goal === 'accepted') return ACCEPTED_STATUSES.includes(status);
  return status === 'done'; // goal === 'done' (дефолт)
}
// Работу уже переназначают/задачи нет — стеречь нечего (стоп без погони).
function isWatchTerminalStop(task) {
  return !task || task.status === 'reassign';
}

function goalVerb(goal) {
  return goal === 'accepted' ? 'принять задачу в работу' : 'отчитаться о выполнении';
}

// Доставляется в чат ВЛАДЕЛЬЦА (босса), но велит писать СОТРУДНИКУ; боссу — тишина.
function wrapWatchChase(row, task, emp, goal, k, max) {
  const who = emp ? `${emp.name} (id=${task.assignee_id})` : `сотрудник id=${task.assignee_id || '?'}`;
  return `[КОНТРОЛЬ «${row.title}» (#${row.id}), напоминание ${k}/${max}]\n`
    + `Задача #${task.id} «${task.title}» назначена: ${who}. Цель: сотрудник должен ${goalVerb(goal)} — `
    + `сейчас статус «${task.status}», цель НЕ достигнута.\n`
    + `Напиши НАПРЯМУЮ этому сотруднику короткое напоминание через message_employee `
    + `(to=${task.assignee_id || who}). Боссу СЕЙЧАС ничего не пиши — заверши ход без ответа боссу `
    + `(система его всё равно не отправит). Не пиши «отправлено», «напоминание отправлено», «пустой ответ».`;
}

// Доставляется боссу: попытки исчерпаны, сотрудник так и не реагирует.
function wrapWatchEscalate(row, task, emp, goal, max) {
  const who = emp ? `${emp.name} (id=${task.assignee_id})` : `сотрудник id=${task.assignee_id || '?'}`;
  return `[ЭСКАЛАЦИЯ «${row.title}» (#${row.id})]\n`
    + `${who} за ${max} напоминаний так и не ${goal === 'accepted' ? 'принял задачу в работу' : 'отчитался'} `
    + `по задаче #${task.id} «${task.title}» (текущий статус «${task.status}»).\n`
    + `Сообщи боссу (это сообщение идёт БОССУ): кто, какая задача, что не реагирует, и предложи следующий шаг `
    + `(переназначить, позвонить, снять задачу). Коротко и по делу.`;
}

// Следующий МОМЕНТ ОСНОВНОГО запуска строкой для БД (или null).
function nextFor(row, now) {
  const d = computeNextRunAt(row, now);
  return d ? fmtUtc(d) : null;
}

// Следующее СОБЫТИЕ автомата фаз: { next: 'YYYY-MM-DD HH:MM:SS', phase } | null.
function nextFireFor(row, now) {
  const f = computeNextFire(row, now);
  return f ? { next: fmtUtc(f.at), phase: f.phase } : null;
}

// Параметры будильника с дефолтами/потолками из конфига.
function nagParams(row) {
  const nagN = Math.max(1, Number(row.nag_interval_min) || 0);
  const max = Math.min(config.SCHEDULE_NAG_MAX_CAP,
    Number(row.nag_max) > 0 ? Number(row.nag_max) : config.SCHEDULE_NAG_MAX_DEFAULT);
  return { nagN, max };
}

let deliverFn = null;   // инъекция из index.js (deliverInstruction)
let timer = null;
let running = false;     // гард: одно исполнение tick за раз (агентный цикл долгий)
let lastCleanupDay = ''; // журнал чистим раз в сутки (старше 90 дней)

function deliverRow(row, instruction, extra = {}) {
  return deliverFn({
    channel: row.owner_channel,
    chatId: row.owner_chat_id,
    phone: row.owner_phone,
    clientName: 'boss',
    instruction,
    title: row.title,
    ...extra,
  });
}

// ── Фаза MAIN: основное срабатывание ────────────────────────────────────────
// Строка уже захвачена claim'ом (next_run_at в БД = NULL); prevNextRunAt — прежнее
// значение для восстановления при lock_busy/ошибке once.
async function runMainPhase(row, now, prevNextRunAt) {
  const res = await deliverRow(row, wrapInstruction(row.title, row.instruction));
  const isOnce = row.kind === 'once';

  if (res && res.ok) {
    // Будильник: повторяем напоминание каждые N минут до подтверждения босса.
    if (Number(row.nag_interval_min) > 0) {
      const { nagN } = nagParams(row);
      await markScheduleRun(row.id, now, 'ok', fmtUtc(new Date(now.getTime() + nagN * 60000)),
        { bumpRunCount: true, firePhase: 'nag', nagCount: 0 });
      await logScheduleRun(row.id, row.title, 'ok', `будильник: повтор каждые ${nagN} мин до подтверждения`);
      return 'ok';
    }
    if (isOnce) {
      await markScheduleRun(row.id, now, 'ok', null, { bumpRunCount: true });
      await setScheduleEnabled(row.id, false); // завершено — больше не опрашиваем
      await logScheduleRun(row.id, row.title, 'ok', null);
      return 'ok';
    }
    // Recurring: следующий запуск (с учётом pre-фазы и until), лимит max_runs.
    const runs = (Number(row.run_count) || 0) + 1;
    const maxRuns = Number(row.max_runs) || 0;
    const nf = nextFireFor(row, now);
    if (!nf || (maxRuns > 0 && runs >= maxRuns)) {
      await markScheduleRun(row.id, now, 'ok', null, { bumpRunCount: true, firePhase: 'main' });
      await setScheduleEnabled(row.id, false);
      await logScheduleRun(row.id, row.title, 'completed',
        !nf ? 'повторы исчерпаны (until)' : `выполнено ${runs} из ${maxRuns} раз`);
      return 'ok';
    }
    await markScheduleRun(row.id, now, 'ok', nf.next, { bumpRunCount: true, firePhase: nf.phase });
    await logScheduleRun(row.id, row.title, 'ok', null);
    return 'ok';
  }

  if (res && res.reason === 'lock_busy') {
    // Чат владельца занят (босс пишет прямо сейчас). Возвращаем прежний next_run_at
    // (claim его занулил) — расписание остаётся due и повторится на следующем tick.
    await setScheduleNextRun(row.id, prevNextRunAt);
    await touchScheduleStatus(row.id, 'lock_busy');
    await logScheduleRun(row.id, row.title, 'lock_busy', 'чат занят, повтор на следующем tick');
    return 'lock_busy';
  }

  // Ошибка агентного цикла. Для once — восстанавливаем due-момент и копим fail_count
  // (ретрай каждый tick, cutoff в БД); для recurring — переносим на следующий раз,
  // чтобы не спамить ретраями каждую минуту.
  const status = (res && res.reason) || 'agent_error';
  if (isOnce) {
    await setScheduleNextRun(row.id, prevNextRunAt);
    await bumpScheduleFail(row.id, status);
  } else {
    const nf = nextFireFor(row, now);
    await markScheduleRun(row.id, now, status, nf ? nf.next : null, { firePhase: nf ? nf.phase : 'main' });
    if (!nf) await setScheduleEnabled(row.id, false);
  }
  await logScheduleRun(row.id, row.title, status, isOnce ? 'once: ретрай, после 3 неудач отключится' : 'перенесено на следующий раз');
  return status;
}

// ── Фаза PRE: пред-напоминание за remind_before_min до основного запуска ────
async function runPrePhase(row, now, prevNextRunAt) {
  // Основной момент восстанавливается из момента pre (свойство computeNextFire).
  const mainAt = computeNextRunAt(row, toUtc(prevNextRunAt));
  if (!mainAt) {
    // Крайний случай: until истёк между pre и main.
    await setScheduleEnabled(row.id, false);
    await logScheduleRun(row.id, row.title, 'completed', 'повторы исчерпаны (until)');
    return 'completed';
  }
  if (now.getTime() >= mainAt.getTime()) {
    // Pre протух за main (бот лежал): пред-напоминание бессмысленно — без двойного
    // сообщения, сразу основной запуск в этом же tick.
    return runMainPhase({ ...row, fire_phase: 'main' }, now, fmtUtc(mainAt));
  }
  const res = await deliverRow(row, wrapPre(row));
  if (res && res.reason === 'lock_busy') {
    await setScheduleNextRun(row.id, prevNextRunAt);
    await touchScheduleStatus(row.id, 'lock_busy');
    return 'lock_busy';
  }
  // ok ИЛИ ошибка превью → промоут в main: сбой пред-напоминания не должен
  // сорвать основной запуск. last_run_at не трогаем (важно для once-логики).
  await updateSchedule(row.id, { fire_phase: 'main', next_run_at: fmtUtc(mainAt) });
  const ok = !!(res && res.ok);
  await logScheduleRun(row.id, row.title, ok ? 'pre_ok' : 'pre_error',
    ok ? `предупреждение за ${row.remind_before_min} мин` : 'сбой пред-напоминания; основной запуск в силе');
  return ok ? 'pre_ok' : 'pre_error';
}

// ── Фаза NAG: будильник-повтор до подтверждения (acknowledge) ───────────────
async function runNagPhase(row, now, prevNextRunAt) {
  const { nagN, max } = nagParams(row);
  const k = (Number(row.nag_count) || 0) + 1;
  const res = await deliverRow(row, wrapNag(row, k, max, nagN));

  if (res && res.ok) {
    if (k >= max) {
      // Повторы исчерпаны без подтверждения.
      if (row.kind === 'once') {
        await markScheduleRun(row.id, now, 'nag_exhausted', null, { nagCount: k });
        await setScheduleEnabled(row.id, false);
      } else {
        const nf = nextFireFor(row, now);
        await markScheduleRun(row.id, now, 'nag_exhausted', nf ? nf.next : null,
          { firePhase: nf ? nf.phase : 'main', nagCount: 0 });
        if (!nf) await setScheduleEnabled(row.id, false);
      }
      await logScheduleRun(row.id, row.title, 'nag_exhausted', `${max} повторов без подтверждения`);
      return 'nag_exhausted';
    }
    await markScheduleRun(row.id, now, 'nag', fmtUtc(new Date(now.getTime() + nagN * 60000)), { nagCount: k });
    await logScheduleRun(row.id, row.title, 'nag', `повтор ${k} из ${max}`);
    return 'nag';
  }

  if (res && res.reason === 'lock_busy') {
    // Повтор не «сгорает» впустую: счётчик не растёт, момент восстановлен.
    await setScheduleNextRun(row.id, prevNextRunAt);
    await touchScheduleStatus(row.id, 'lock_busy');
    return 'lock_busy';
  }

  const status = (res && res.reason) || 'agent_error';
  await setScheduleNextRun(row.id, prevNextRunAt);
  await bumpScheduleFail(row.id, status); // cutoff 3 отключит и не даст спамить
  await logScheduleRun(row.id, row.title, status, 'будильник: ретрай, после 3 неудач отключится');
  return status;
}

// ── Сторож исполнения: проверка статуса задачи, погоня сотрудника, эскалация ──
// Только kind=once (валидируется в manage_schedule). Один обработчик и для первого
// срабатывания (fire_phase main), и для повторов-напоминаний (fire_phase watch):
// каждый раз читаем АКТУАЛЬНЫЙ статус задачи из БД и решаем кодом.
async function runWatchPhase(row, now, prevNextRunAt) {
  const goal = row.watch_goal || 'done';
  const task = await getTask(row.watch_task_id);

  // Цель достигнута ИЛИ стеречь нечего (задача удалена/переназначается) — тихо снять контроль.
  if (isWatchTerminalStop(task) || isGoalMet(goal, task.status)) {
    const stopStatus = isWatchTerminalStop(task) ? 'watch_stopped' : 'watch_done';
    const detail = !task ? 'задача не найдена'
      : (task.status === 'reassign' ? 'задача переназначается' : `цель «${goal}» достигнута (${task.status})`);
    await markScheduleRun(row.id, now, stopStatus, null, { bumpRunCount: true });
    await setScheduleEnabled(row.id, false);
    await logScheduleRun(row.id, row.title, stopStatus, detail);
    return stopStatus;
  }

  const { nagN, max } = nagParams(row);
  const k = (Number(row.nag_count) || 0) + 1;
  const emp = task.assignee_id ? await getEmployeeById(task.assignee_id) : null;

  // Попытки исчерпаны — эскалация боссу (в чат владельца).
  if (k > max) {
    const res = await deliverRow(row, wrapWatchEscalate(row, task, emp, goal, max));
    if (res && res.reason === 'lock_busy') {
      await setScheduleNextRun(row.id, prevNextRunAt);
      await touchScheduleStatus(row.id, 'lock_busy');
      return 'lock_busy';
    }
    if (!res || !res.ok) {
      const status = (res && res.reason) || 'agent_error';
      await setScheduleNextRun(row.id, prevNextRunAt);
      await bumpScheduleFail(row.id, status);
      await logScheduleRun(row.id, row.title, status, 'эскалация: ретрай, после 3 неудач отключится');
      return status;
    }
    await markScheduleRun(row.id, now, 'watch_escalated', null, { nagCount: k });
    await setScheduleEnabled(row.id, false);
    await logScheduleRun(row.id, row.title, 'watch_escalated', `${max} напоминаний без результата — боссу`);
    return 'watch_escalated';
  }

  // Есть попытки — напоминаем СОТРУДНИКУ (боссу тихо), планируем следующую проверку.
  // silentToOwner: ответ боссу не отправляем ВООБЩЕ (погоня адресована сотруднику) —
  // даже если модель проговорит «отправлено/пустой ответ». message_employee уже ушёл.
  const res = await deliverRow(row, wrapWatchChase(row, task, emp, goal, k, max), { silentToOwner: true });
  if (res && res.reason === 'lock_busy') {
    await setScheduleNextRun(row.id, prevNextRunAt);
    await touchScheduleStatus(row.id, 'lock_busy');
    return 'lock_busy';
  }
  if (!res || !res.ok) {
    const status = (res && res.reason) || 'agent_error';
    await setScheduleNextRun(row.id, prevNextRunAt);
    await bumpScheduleFail(row.id, status);
    await logScheduleRun(row.id, row.title, status, 'контроль: ретрай, после 3 неудач отключится');
    return status;
  }
  await markScheduleRun(row.id, now, 'watch', fmtUtc(new Date(now.getTime() + nagN * 60000)),
    { firePhase: 'watch', nagCount: k });
  await logScheduleRun(row.id, row.title, 'watch', `напоминание ${k} из ${max} сотруднику`);
  return 'watch';
}

// Выполнить одно захваченное расписание согласно его фазе.
async function runSchedule(row, now, prevNextRunAt) {
  // Сторож исполнения перехватывает любую фазу: и первый запуск, и повторы.
  if (row.watch_task_id) return runWatchPhase(row, now, prevNextRunAt);
  const phase = row.fire_phase || 'main';
  if (phase === 'pre') return runPrePhase(row, now, prevNextRunAt);
  if (phase === 'nag') return runNagPhase(row, now, prevNextRunAt);
  return runMainPhase(row, now, prevNextRunAt);
}

// Свежий захват другим процессом (перекрытие на деплое) не трогаем; старше — считаем
// прогон оборванным (рестарт посреди доставки) и перевзводим.
const STUCK_RUN_MIN = 15;

// Строка без next_run_at: legacy до миграции, ручная правка в БД или оборванный
// claim (рестарт между захватом и фиксацией). Дозаполнить по фазе; завершённое
// once реанимировать нечем — выключаем, чтобы не опрашивать вечно.
async function rearmSchedule(row, now) {
  if (row.last_status === 'running' && row.updated_at) {
    const ageMs = Math.abs(now.getTime() - toUtc(row.updated_at).getTime());
    if (ageMs < STUCK_RUN_MIN * 60000) return; // прогон идёт прямо сейчас
  }
  // Оборванный будильник дозванивает: следующий повтор от «сейчас».
  if ((row.fire_phase || 'main') === 'nag' && Number(row.nag_interval_min) > 0) {
    const { nagN } = nagParams(row);
    await setScheduleNextRun(row.id, fmtUtc(new Date(now.getTime() + nagN * 60000)));
    return;
  }
  const nf = nextFireFor(row, now);
  if (nf) {
    if ((row.fire_phase || 'main') === nf.phase) await setScheduleNextRun(row.id, nf.next);
    else await updateSchedule(row.id, { fire_phase: nf.phase, next_run_at: nf.next });
  } else {
    await setScheduleEnabled(row.id, false);
    await logScheduleRun(row.id, row.title, 'auto_disabled',
      'не удалось вычислить следующий запуск — расписание выключено');
  }
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
    // Тихий режим: владельцы, которым сейчас нельзя писать первым. Их созревшие
    // расписания держим (next_run_at не трогаем) — сработают, когда режим снимут.
    // Долгий простой recurring потом подчистит окно catch-up как обычно.
    const quiet = new Set(
      (await listActiveQuiet()).map((q) => `${q.owner_channel}|${q.owner_chat_id}`)
    );
    for (const row of rows) {
      try {
        // Тихий режим уважают напоминания/сводки боссу. Сторож исполнения (watch_task_id)
        // — исключение: его погоня пишет СОТРУДНИКУ (не боссу), а эскалация — это
        // критичный алерт, который босс сам себе настроил; такое /stop не глушит.
        if (!row.watch_task_id && quiet.has(`${row.owner_channel}|${row.owner_chat_id}`)) continue;
        if (!row.next_run_at) { await rearmSchedule(row, now); continue; }
        if (!isDue(row, now)) continue;
        // Атомарный claim: между снимком rows и этим местом расписание могли отменить
        // или перенести (manage_schedule из чата босса), а при перекрытии процессов на
        // деплое — забрать другой инстанс. Запускаем, только если захват наш.
        const prevNextRunAt = fmtUtc(toUtc(row.next_run_at));
        if (!(await claimSchedule(row.id, prevNextRunAt))) continue;
        // Сильно протухший фиксированный recurring (простой дольше окна) — missed,
        // переносим: дневная сводка в 18:00 уже не нужна. once досылаем всегда;
        // nag-повторы (будильник) тоже досылаются всегда; pre обрабатывает протухание
        // сам (промоут в main без двойного сообщения).
        if (RECURRING_FIXED.includes(row.kind) && (row.fire_phase || 'main') === 'main') {
          const lateMs = now.getTime() - toUtc(row.next_run_at).getTime();
          if (lateMs > config.SCHEDULE_CATCHUP_WINDOW_MIN * 60000) {
            const nf = nextFireFor(row, now);
            await markScheduleRun(row.id, now, 'missed', nf ? nf.next : null, { firePhase: nf ? nf.phase : 'main' });
            if (!nf) await setScheduleEnabled(row.id, false);
            await logScheduleRun(row.id, row.title, 'missed',
              `опоздание ${Math.round(lateMs / 60000)} мин > окна ${config.SCHEDULE_CATCHUP_WINDOW_MIN} мин`);
            continue;
          }
        }
        await runSchedule(row, now, prevNextRunAt);
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
  _internals: {
    isDue, wrapInstruction, tick, runSchedule, isGoalMet, runWatchPhase,
    setDeliver: (f) => { deliverFn = f; },
  },
};

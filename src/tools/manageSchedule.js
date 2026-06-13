'use strict';
// Планирование собственных действий ИИ: отложенные (once) и регулярные (daily/weekly/
// monthly/interval) задачи. В момент срабатывания scheduledRunner выполнит instruction
// через обычный агентный цикл (доступны все инструменты). Только режим БОССА (BOSS_ONLY).
//
// Время: ВСЁ, что вводит LLM (run_at, at_hour/at_minute), — локальное время компании
// (UTC+5); конвертация в UTC для хранения происходит здесь, LLM не считает пояса.
// next_run_at (UTC) предвычисляется при create/update/enable — раннер просто сравнивает с now.
const {
  createSchedule, listSchedulesByOwner, getSchedule, updateSchedule,
  setScheduleEnabled, deleteSchedule, countSchedules, listScheduleRuns, logScheduleRun,
} = require('../services/mysql');
const { computeNextRunAt, computeNextFire, fmtTimeLeft, toUtc, fmtUtc } = require('../utils/scheduleTime');
const { localNow } = require('../utils/localTime');
const { handleToolDbError } = require('../utils/toolError');
const config = require('../config');

const definition = {
  type: 'function',
  function: {
    name: 'manage_schedule',
    description:
      'Планировать СОБСТВЕННЫЕ действия на будущее (личный календарь — у каждого свой): '
      + 'календарь + будильник + таймер. '
      + '«напиши через час», «завтра в 15:00 проверь план X», «каждый день в 9:00 — сводка», '
      + '«день рождения мамы 14 марта», «напоминай каждые 10 минут, пока не отвечу». '
      + 'В момент срабатывания ты выполнишь instruction своим обычным циклом (доступны все инструменты). '
      + 'Действия: create / list / update / cancel / enable / run_now / history / '
      + 'acknowledge (снять будильник после «ок» босса) / snooze (отложить на N минут) / '
      + 'skip_next (пропустить ближайшее вхождение recurring) / agenda (что запланировано на сегодня/неделю). '
      + 'ОТНОСИТЕЛЬНОЕ время («через N минут/часов») → ВСЕГДА delay_minutes; «отложи на N» → snooze_minutes. '
      + 'НИКОГДА не вычисляй дату/время сам. АБСОЛЮТНОЕ («завтра в 15:00») → run_at в ЛОКАЛЬНОМ времени '
      + '(Казахстан, UTC+5; текущее локальное есть в системном штампе). at_hour/at_minute — тоже '
      + 'локальные. weekdays: Пн=1..Вс=7. month_days: числа месяца. run_now вернёт инструкцию — '
      + 'выполни её сразу в этом же ответе. history — журнал запусков («почему вчера не пришло?»). '
      + 'Не путай с manage_scheduler (тот — про фиксированные рассылки).',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['create', 'list', 'update', 'cancel', 'enable', 'run_now', 'history',
            'acknowledge', 'snooze', 'skip_next', 'agenda'],
          description: 'Что сделать. enable — включить обратно выключенное; history — журнал запусков; '
            + 'acknowledge — босс подтвердил будильник («ок/понял») — перестать повторять; '
            + 'snooze — отложить срабатывание; skip_next — пропустить ближайшее вхождение; '
            + 'agenda — список ближайших срабатываний.',
        },
        id: { type: 'integer', description: 'id расписания (update/cancel/enable/run_now/history/skip_next; для acknowledge/snooze опционален — без id возьмётся ждущий подтверждения будильник).' },
        title: { type: 'string', description: 'Короткое имя расписания (для create/update).' },
        instruction: { type: 'string', description: 'Что бот должен сделать в момент срабатывания (естественным языком).' },
        kind: {
          type: 'string',
          enum: ['once', 'daily', 'weekly', 'monthly', 'yearly', 'interval'],
          description: 'Тип расписания. yearly — ежегодная дата (дни рождения, годовщины).',
        },
        delay_minutes: {
          type: 'integer',
          description: 'kind=once, ОТНОСИТЕЛЬНОЕ время: через сколько МИНУТ сработать («через час»=60, '
            + '«через 30 минут»=30, «через 2 часа»=120). Момент вычислит код — дату НЕ считай. '
            + 'Альтернатива run_at: укажи ровно одно из двух.',
        },
        run_at: { type: 'string', description: 'kind=once, АБСОЛЮТНОЕ время: момент в ЛОКАЛЬНОМ времени (UTC+5), формат YYYY-MM-DD HH:MM:SS. Для «через N минут» используй delay_minutes.' },
        at_hour: { type: 'integer', description: 'daily/weekly/monthly: час 0–23 в локальном времени (UTC+5).' },
        at_minute: { type: 'integer', description: 'Минута 0–59 (по умолчанию 0).' },
        weekdays: { type: 'string', description: 'weekly: дни недели через запятую, Пн=1..Вс=7 (напр. «1,3,5»).' },
        month_days: { type: 'string', description: 'monthly: числа месяца через запятую (напр. «1,15»).' },
        interval_min: { type: 'integer', description: `interval: период в минутах (минимум ${config.SCHEDULE_MIN_INTERVAL_MIN}).` },
        yearly_date: { type: 'string', description: 'yearly: дата «MM-DD» («день рождения 14 марта» → «03-14»), время — at_hour/at_minute.' },
        nag_interval_min: { type: 'integer', description: `БУДИЛЬНИК: после срабатывания повторять напоминание каждые N минут, пока босс не подтвердит («ок»). Минимум ${config.SCHEDULE_NAG_MIN_INTERVAL_MIN}. Используй, когда босс просит «напоминай, пока не отвечу».` },
        nag_max: { type: 'integer', description: `Будильник: максимум повторов (по умолчанию ${config.SCHEDULE_NAG_MAX_DEFAULT}, потолок ${config.SCHEDULE_NAG_MAX_CAP}).` },
        remind_before_min: { type: 'integer', description: 'КАЛЕНДАРЬ: пред-напоминание за N минут ДО срабатывания (5–1440). «предупреди за полчаса» → 30. Не для interval.' },
        until_date: { type: 'string', description: 'Последний день повторов ВКЛЮЧИТЕЛЬНО, локальная дата YYYY-MM-DD («каждый день до пятницы» → дата этой пятницы). Только для регулярных.' },
        max_runs: { type: 'integer', description: 'Остановиться после N срабатываний (1–365). «напомни 3 раза» → 3. Только для регулярных.' },
        snooze_minutes: { type: 'integer', description: 'snooze: на сколько минут отложить (1–1440). «отложи на 10 минут» → 10. Время считает код.' },
        horizon: { type: 'string', enum: ['today', 'tomorrow', 'week', 'all'], description: 'agenda: горизонт обзора (по умолчанию today).' },
        include_disabled: { type: 'boolean', description: 'list: показать и выключенные расписания.' },
        delete: { type: 'boolean', description: 'cancel: true — удалить совсем (иначе мягко выключить, можно вернуть через enable).' },
      },
      required: ['action'],
    },
  },
};

const KIND_REQUIRED = {
  once: [],            // once: ровно одно из run_at | delay_minutes — отдельная проверка
  daily: ['at_hour'],
  weekly: ['at_hour', 'weekdays'],
  monthly: ['at_hour', 'month_days'],
  yearly: ['at_hour', 'yearly_date'],
  interval: ['interval_min'],
};
// Поля, влияющие на время срабатывания: их правка перевзводит расписание.
const TIMING_FIELDS = ['kind', 'run_at', 'at_hour', 'at_minute', 'weekdays', 'month_days',
  'interval_min', 'yearly_date', 'until_at', 'remind_before_min'];
const RECURRING_KINDS = ['daily', 'weekly', 'monthly', 'yearly', 'interval'];
const DAYS_IN_MONTH = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]; // февраль: 29 допустим

const MAX_DELAY_MIN = 43200; // 30 дней — дальше это уже не «через N минут», а дата

// once: входные args → UTC Date момента срабатывания (из delay_minutes ИЛИ run_at).
// Возвращает { runAtUtc } или { err }.
function resolveOnceMoment(args) {
  const hasDelay = args.delay_minutes !== undefined && args.delay_minutes !== null;
  const hasRunAt = args.run_at !== undefined && args.run_at !== null && args.run_at !== '';
  if (hasDelay && hasRunAt) {
    return { err: 'Укажи РОВНО ОДНО: delay_minutes (через N минут) ИЛИ run_at (конкретный момент), не оба сразу.' };
  }
  if (!hasDelay && !hasRunAt) {
    return { err: 'Для once укажи delay_minutes (через N минут — для «через час» и т.п.) или run_at (локальное время).' };
  }
  if (hasDelay) {
    const d = Number(args.delay_minutes);
    if (!Number.isInteger(d) || d < 1 || d > MAX_DELAY_MIN) {
      return { err: `delay_minutes должен быть целым 1–${MAX_DELAY_MIN} (минут). Для дальних дат используй run_at.` };
    }
    return { runAtUtc: new Date(Date.now() + d * 60000) };
  }
  const t = localStrToUtc(args.run_at);
  if (!t) return { err: 'run_at не распознан. Формат: YYYY-MM-DD HH:MM:SS (локальное время). Для «через N минут» используй delay_minutes.' };
  return { runAtUtc: t };
}

// 'YYYY-MM-DD HH:MM[:SS]' в локальном поясе → UTC Date (null = не распознано).
function localStrToUtc(s) {
  const m = String(s).trim().match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})(?::(\d{2}))?$/);
  if (!m) return null;
  const t = Date.parse(`${m[1]}T${m[2]}:${m[3] || '00'}Z`);
  if (isNaN(t)) return null;
  return new Date(t - config.SCHEDULER_TZ_OFFSET_MIN * 60000);
}

// UTC (Date или строка из БД) → 'YYYY-MM-DD HH:MM' в локальном поясе.
function utcToLocalStr(v) {
  if (!v) return null;
  return localNow(toUtc(v)).toISOString().slice(0, 16).replace('T', ' ');
}

// Локальная дата 'YYYY-MM-DD' → UTC Date конца этого дня (23:59:59 локально).
// null = не распознано. Для until_date: «до пятницы» включает всю пятницу.
function localDateEndToUtc(s) {
  const m = String(s).trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const t = Date.parse(`${m[1]}-${m[2]}-${m[3]}T23:59:59Z`);
  if (isNaN(t)) return null;
  return new Date(t - config.SCHEDULER_TZ_OFFSET_MIN * 60000);
}

// CSV-список целых чисел в [lo..hi]: вернуть текст ошибки или null.
// Невалидный токен («0», «Mon», «32») без этой проверки давал бы расписание,
// которое никогда не совпадает с днём → next_run_at=NULL → тихое самоотключение.
function validateCsvInts(csv, lo, hi, label) {
  const toks = String(csv).split(',').map((s) => s.trim()).filter(Boolean);
  if (!toks.length) return `${label}: пустой список.`;
  for (const t of toks) {
    if (!/^\d{1,2}$/.test(t) || Number(t) < lo || Number(t) > hi) {
      return `${label}: «${t}» не входит в ${lo}–${hi}.`;
    }
  }
  return null;
}

function validateSpec(spec) {
  if (!spec.title) return 'Нужно title (короткое имя расписания).';
  if (!spec.instruction) return 'Нужно instruction (что сделать).';
  if (!spec.kind || !KIND_REQUIRED[spec.kind]) return 'Нужен корректный kind: once/daily/weekly/monthly/interval.';
  for (const f of KIND_REQUIRED[spec.kind]) {
    if (spec[f] === undefined || spec[f] === null || spec[f] === '') {
      return `Для kind=${spec.kind} нужно поле ${f}.`;
    }
  }
  if (spec.kind === 'weekly') {
    const e = validateCsvInts(spec.weekdays, 1, 7, 'weekdays');
    if (e) return `${e} Дни недели: Пн=1..Вс=7 (воскресенье — 7, НЕ 0).`;
  }
  if (spec.kind === 'monthly') {
    const e = validateCsvInts(spec.month_days, 1, 31, 'month_days');
    if (e) return `${e} Числа месяца: 1–31.`;
  }
  // once: к моменту валидации run_at уже должен быть установлен (из run_at или delay_minutes).
  if (spec.kind === 'once' && !spec.run_at) {
    return 'Для once укажи delay_minutes (через N минут) или run_at (локальное время).';
  }
  if (['daily', 'weekly', 'monthly'].includes(spec.kind)) {
    const h = Number(spec.at_hour);
    if (!Number.isInteger(h) || h < 0 || h > 23) return 'at_hour должен быть 0–23.';
    const m = (spec.at_minute === undefined || spec.at_minute === null) ? 0 : Number(spec.at_minute);
    if (!Number.isInteger(m) || m < 0 || m > 59) return 'at_minute должен быть 0–59.';
  }
  if (spec.kind === 'interval') {
    const min = Number(spec.interval_min);
    if (!Number.isInteger(min) || min < config.SCHEDULE_MIN_INTERVAL_MIN) {
      return `interval_min должен быть целым >= ${config.SCHEDULE_MIN_INTERVAL_MIN} (каждый запуск — полный цикл ИИ).`;
    }
  }
  if (spec.kind === 'yearly') {
    const m = String(spec.yearly_date || '').match(/^(\d{2})-(\d{2})$/);
    if (!m) return 'yearly_date должен быть в формате «MM-DD» (14 марта → «03-14»).';
    const mo = Number(m[1]), day = Number(m[2]);
    if (mo < 1 || mo > 12 || day < 1 || day > DAYS_IN_MONTH[mo - 1]) {
      return `yearly_date «${spec.yearly_date}»: такой даты не бывает.`;
    }
  }
  if (spec.nag_interval_min !== undefined && spec.nag_interval_min !== null) {
    const n = Number(spec.nag_interval_min);
    if (!Number.isInteger(n) || n < config.SCHEDULE_NAG_MIN_INTERVAL_MIN || n > 1440) {
      return `nag_interval_min должен быть целым ${config.SCHEDULE_NAG_MIN_INTERVAL_MIN}–1440 (минут между повторами будильника).`;
    }
  }
  if (spec.nag_max !== undefined && spec.nag_max !== null) {
    const n = Number(spec.nag_max);
    if (!Number.isInteger(n) || n < 1 || n > config.SCHEDULE_NAG_MAX_CAP) {
      return `nag_max должен быть целым 1–${config.SCHEDULE_NAG_MAX_CAP}.`;
    }
  }
  if (spec.remind_before_min !== undefined && spec.remind_before_min !== null) {
    if (spec.kind === 'interval') return 'remind_before_min не сочетается с interval (период и так короткий).';
    const n = Number(spec.remind_before_min);
    if (!Number.isInteger(n) || n < 5 || n > 1440) return 'remind_before_min должен быть целым 5–1440 (минут до срабатывания).';
  }
  if (spec.until_at && spec.kind === 'once') return 'until_date только для регулярных расписаний (для once укажи run_at).';
  if (spec.max_runs !== undefined && spec.max_runs !== null) {
    if (spec.kind === 'once') return 'max_runs только для регулярных расписаний.';
    const n = Number(spec.max_runs);
    if (!Number.isInteger(n) || n < 1 || n > 365) return 'max_runs должен быть целым 1–365.';
  }
  return null;
}

// Человекочитаемое описание «когда» — для list/agenda. Время — локальное.
function describeWhen(row) {
  const at = `${String(row.at_hour).padStart(2, '0')}:${String(row.at_minute || 0).padStart(2, '0')}`;
  let base;
  switch (row.kind) {
    case 'once': base = `разово ${utcToLocalStr(row.run_at)} (локальное время)`; break;
    case 'daily': base = `каждый день в ${at}`; break;
    case 'weekly': base = `по дням недели ${row.weekdays} в ${at}`; break;
    case 'monthly': base = `по числам ${row.month_days} в ${at}`; break;
    case 'yearly': {
      const m = String(row.yearly_date || '').match(/^(\d{2})-(\d{2})$/);
      base = `каждый год ${m ? `${m[2]}.${m[1]}` : row.yearly_date} в ${at}`; break;
    }
    case 'interval': base = `каждые ${row.interval_min} мин`; break;
    default: base = row.kind;
  }
  const extras = [];
  if (Number(row.remind_before_min) > 0) extras.push(`предупрежу за ${row.remind_before_min} мин`);
  if (Number(row.nag_interval_min) > 0) extras.push(`повтор каждые ${row.nag_interval_min} мин до подтверждения`);
  if (row.until_at) extras.push(`до ${utcToLocalStr(row.until_at)}`);
  if (Number(row.max_runs) > 0) extras.push(`ещё ${Math.max(0, Number(row.max_runs) - (Number(row.run_count) || 0))} раз`);
  return extras.length ? `${base} (${extras.join('; ')})` : base;
}

// Ждущие подтверждения будильники владельца (фаза nag) — для acknowledge/snooze без id.
async function listAwaiting(context) {
  const rows = await listSchedulesByOwner(context.channel, context.chatId, false);
  return rows.filter((r) => r.fire_phase === 'nag');
}

// Расписание по id, но только своё: чужое (другой чат/канал) выглядит как «не найдено».
async function getOwned(id, context) {
  if (!id) return { err: 'Нужен id расписания.' };
  const row = await getSchedule(id);
  if (!row || row.owner_channel !== context.channel || String(row.owner_chat_id) !== String(context.chatId)) {
    return { err: `Расписание #${id} не найдено.` };
  }
  return { row };
}

async function handler(args, context = {}) {
  try {
    switch (args.action) {
      case 'create': {
        const active = await countSchedules();
        if (active >= config.SCHEDULE_MAX_ACTIVE) {
          return { success: false, message: `Достигнут лимит активных расписаний (${config.SCHEDULE_MAX_ACTIVE}). Отмени ненужные (cancel) и повтори.` };
        }
        const warn = [];
        let runAtUtc = null;
        if (args.kind === 'once') {
          const m = resolveOnceMoment(args);
          if (m.err) return { success: false, message: m.err };
          runAtUtc = m.runAtUtc;
          if (runAtUtc.getTime() < Date.now() - 5 * 60000) {
            warn.push('run_at в прошлом — расписание сработает один раз сразу. Если это не задумано, проверь дату.');
          }
        }
        let untilUtc = null;
        if (args.until_date !== undefined && args.until_date !== null && args.until_date !== '') {
          untilUtc = localDateEndToUtc(args.until_date);
          if (!untilUtc) return { success: false, message: 'until_date не распознан. Формат: YYYY-MM-DD (локальная дата последнего дня повторов).' };
          if (untilUtc.getTime() <= Date.now()) return { success: false, message: 'until_date уже в прошлом — расписание не создано.' };
        }
        const fixedDaily = ['daily', 'weekly', 'monthly', 'yearly'].includes(args.kind);
        const spec = {
          title: args.title,
          instruction: args.instruction,
          kind: args.kind,
          run_at: runAtUtc ? fmtUtc(runAtUtc) : null,
          at_hour: fixedDaily && args.at_hour !== undefined ? Number(args.at_hour) : null,
          at_minute: fixedDaily ? (Number(args.at_minute) || 0) : null,
          weekdays: args.kind === 'weekly' && args.weekdays !== undefined ? String(args.weekdays) : null,
          month_days: args.kind === 'monthly' && args.month_days !== undefined ? String(args.month_days) : null,
          yearly_date: args.kind === 'yearly' && args.yearly_date !== undefined ? String(args.yearly_date) : null,
          interval_min: args.kind === 'interval' && args.interval_min !== undefined ? Number(args.interval_min) : null,
          nag_interval_min: args.nag_interval_min ?? null,
          nag_max: args.nag_max ?? null,
          remind_before_min: args.remind_before_min ?? null,
          until_at: untilUtc ? fmtUtc(untilUtc) : null,
          max_runs: args.max_runs ?? null,
        };
        const err = validateSpec(spec);
        if (err) return { success: false, message: err };
        const nf = computeNextFire(spec, new Date());
        if (!nf) {
          return { success: false, message: 'Не удалось вычислить следующий запуск по этим параметрам — расписание не создано. Проверь kind, поля времени и until_date.' };
        }
        if (spec.remind_before_min && nf.phase === 'main' && spec.kind === 'once') {
          warn.push(`пред-напоминание пропущено: до срабатывания уже меньше ${spec.remind_before_min} мин.`);
        }
        const id = await createSchedule({
          owner_channel: context.channel,
          owner_chat_id: context.chatId,
          owner_phone: String(context.phone || '').replace(/\D/g, '') || null,
          ...spec,
          next_run_at: fmtUtc(nf.at),
          fire_phase: nf.phase,
        });
        const runAtLocal = runAtUtc ? utcToLocalStr(runAtUtc) : null;
        console.log(`[Schedule] create #${id} «${args.title}» ${args.kind}`
          + (args.delay_minutes ? ` delay=${args.delay_minutes}м` : '')
          + ` → next ${fmtUtc(nf.at)} UTC/${nf.phase} (owner ${context.channel}:${String(context.chatId).slice(0, 6)}…)`);
        const mode = [];
        if (spec.remind_before_min && nf.phase === 'pre') mode.push(`предупрежу за ${spec.remind_before_min} мин`);
        if (spec.nag_interval_min) mode.push(`буду повторять каждые ${spec.nag_interval_min} мин, пока не подтвердишь («ок»)`);
        return {
          success: true, id, title: args.title, when: describeWhen(spec),
          run_at_local: runAtLocal,
          next_run_local: utcToLocalStr(nf.at),
          next_fire_phase: nf.phase,
          confirm_to_boss: runAtLocal
            ? `Сработает ${runAtLocal} (локальное)${args.delay_minutes ? ` — через ${args.delay_minutes} мин` : ''}${mode.length ? '; ' + mode.join('; ') : ''}`
            : (mode.length ? mode.join('; ') : null),
          warnings: warn,
        };
      }

      case 'list': {
        const rows = await listSchedulesByOwner(context.channel, context.chatId, !!args.include_disabled);
        const nowMs = Date.now();
        return {
          success: true,
          count: rows.length,
          schedules: rows.map((r) => ({
            id: r.id, title: r.title, when: describeWhen(r), enabled: !!r.enabled,
            next_run_local: utcToLocalStr(r.next_run_at),
            time_left: r.next_run_at ? fmtTimeLeft(toUtc(r.next_run_at).getTime() - nowMs) : null,
            awaiting_ack: r.fire_phase === 'nag' ? true : undefined,
            runs_left: Number(r.max_runs) > 0 ? Math.max(0, Number(r.max_runs) - (Number(r.run_count) || 0)) : undefined,
            until_local: r.until_at ? utcToLocalStr(r.until_at) : undefined,
            last_run_local: utcToLocalStr(r.last_run_at), last_status: r.last_status,
          })),
        };
      }

      case 'update': {
        const { row, err } = await getOwned(args.id, context);
        if (err) return { success: false, message: err };
        const fields = {};
        for (const f of ['title', 'instruction', 'kind', 'at_hour', 'at_minute', 'weekdays', 'month_days',
          'interval_min', 'yearly_date', 'nag_interval_min', 'nag_max', 'remind_before_min', 'max_runs']) {
          if (args[f] !== undefined) fields[f] = args[f];
        }
        if (args.until_date !== undefined) {
          if (args.until_date === null || args.until_date === '') {
            fields.until_at = null; // снять ограничение
          } else {
            const u = localDateEndToUtc(args.until_date);
            if (!u) return { success: false, message: 'until_date не распознан. Формат: YYYY-MM-DD.' };
            if (u.getTime() <= Date.now()) return { success: false, message: 'until_date уже в прошлом.' };
            fields.until_at = fmtUtc(u);
          }
        }
        const wantsDelay = args.delay_minutes !== undefined && args.delay_minutes !== null;
        const wantsRunAt = args.run_at !== undefined && args.run_at !== null && args.run_at !== '';
        if (wantsDelay || wantsRunAt) {
          const targetKind = args.kind !== undefined ? args.kind : row.kind;
          if (targetKind !== 'once') {
            return { success: false, message: 'delay_minutes/run_at применимы только к kind=once.' };
          }
          const m = resolveOnceMoment(args);
          if (m.err) return { success: false, message: m.err };
          fields.run_at = fmtUtc(m.runAtUtc);
        }
        if (!Object.keys(fields).length) return { success: false, message: 'Нет полей для обновления.' };
        // Валидируем ИТОГОВОЕ состояние (строка + правки), чтобы смена kind не оставила
        // расписание без обязательных полей — иначе оно молча перестанет срабатывать.
        const merged = { ...row, ...fields };
        const vErr = validateSpec(merged);
        if (vErr) return { success: false, message: vErr };
        // Правка времени перевзводит расписание: сбрасываем след прошлого запуска,
        // фазу и ошибки, включаем обратно — иначе перенесённое once никогда не сработает.
        let reEnabled = false;
        if (TIMING_FIELDS.some((f) => fields[f] !== undefined)) {
          merged.last_run_at = null;
          const nf = computeNextFire(merged, new Date());
          if (!nf) {
            return { success: false, message: 'С такими параметрами времени следующий запуск не вычисляется — правка отклонена, расписание не изменено.' };
          }
          fields.next_run_at = fmtUtc(nf.at);
          fields.fire_phase = nf.phase;
          fields.nag_count = 0;
          fields.last_run_at = null;
          fields.fail_count = 0;
          fields.enabled = 1;
          reEnabled = !row.enabled;
        }
        const n = await updateSchedule(args.id, fields);
        console.log(`[Schedule] update #${args.id} «${row.title}» поля: ${Object.keys(fields).join(',')}`
          + (fields.next_run_at ? ` → next ${fields.next_run_at} UTC` : ''));
        return {
          success: n > 0, id: args.id, updated_fields: n,
          next_run_local: fields.next_run_at ? utcToLocalStr(fields.next_run_at) : utcToLocalStr(row.next_run_at),
          re_enabled: reEnabled || undefined, // правка времени включила выключенное — скажи об этом боссу
        };
      }

      case 'cancel': {
        const { row, err } = await getOwned(args.id, context);
        if (err) return { success: false, message: err };
        console.log(`[Schedule] cancel #${row.id} «${row.title}»${args.delete ? ' (delete)' : ''}`);
        if (args.delete) { await deleteSchedule(row.id); return { success: true, id: row.id, deleted: true }; }
        await setScheduleEnabled(row.id, false);
        return { success: true, id: row.id, disabled: true, note: 'Можно вернуть действием enable.' };
      }

      case 'enable': {
        const { row, err } = await getOwned(args.id, context);
        if (err) return { success: false, message: err };
        const nf = computeNextFire({ ...row, last_run_at: row.kind === 'once' ? row.last_run_at : null }, new Date());
        if (!nf) {
          return { success: false, message: 'Это расписание уже завершено (once выполнено или повторы исчерпаны) — обнови время (update), чтобы запланировать заново.' };
        }
        await updateSchedule(row.id, { enabled: 1, fail_count: 0, next_run_at: fmtUtc(nf.at), fire_phase: nf.phase, nag_count: 0 });
        return { success: true, id: row.id, enabled: true, next_run_local: utcToLocalStr(nf.at) };
      }

      case 'run_now': {
        const { row, err } = await getOwned(args.id, context);
        if (err) return { success: false, message: err };
        console.log(`[Schedule] run_now #${row.id} «${row.title}» (owner ${context.channel})`);
        // Мы уже ВНУТРИ агентного цикла (лок чата у нас) — запускать через scheduledRunner
        // нельзя (вечный lock_busy). Возвращаем инструкцию: выполни её прямо сейчас.
        return {
          success: true,
          id: row.id,
          execute_now: true,
          title: row.title,
          instruction: row.instruction,
          note: 'Выполни эту инструкцию ПРЯМО СЕЙЧАС в текущем ответе (все инструменты доступны). Само расписание не изменилось и сработает по плану.',
        };
      }

      case 'history': {
        const { row, err } = await getOwned(args.id, context);
        if (err) return { success: false, message: err };
        const runs = await listScheduleRuns(row.id, 10);
        return {
          success: true,
          id: row.id,
          title: row.title,
          runs: runs.map((r) => ({
            ran_at_local: utcToLocalStr(r.ran_at),
            status: r.status,
            detail: r.detail || undefined,
          })),
          note: runs.length ? undefined : 'Запусков ещё не было (журнал ведётся с момента включения функции).',
        };
      }

      // Босс подтвердил будильник («ок», «понял», «сделал») — перестать повторять.
      case 'acknowledge': {
        let row;
        if (args.id) {
          const r = await getOwned(args.id, context);
          if (r.err) return { success: false, message: r.err };
          row = r.row;
          if (row.fire_phase !== 'nag') {
            return { success: false, message: `Расписание #${row.id} «${row.title}» сейчас не ждёт подтверждения.` };
          }
        } else {
          const waiting = await listAwaiting(context);
          if (!waiting.length) return { success: false, message: 'Нет напоминаний, ждущих подтверждения.' };
          if (waiting.length > 1) {
            return {
              success: false,
              message: 'Подтверждения ждут несколько напоминаний — укажи id.',
              waiting: waiting.map((r) => ({ id: r.id, title: r.title })),
            };
          }
          row = waiting[0];
        }
        let nextLocal = null;
        if (row.kind === 'once') {
          await updateSchedule(row.id, { enabled: 0, fire_phase: 'main', nag_count: 0, next_run_at: null });
        } else {
          const nf = computeNextFire(row, new Date());
          if (nf) {
            await updateSchedule(row.id, { fire_phase: nf.phase, nag_count: 0, next_run_at: fmtUtc(nf.at) });
            nextLocal = utcToLocalStr(nf.at);
          } else {
            await updateSchedule(row.id, { enabled: 0, fire_phase: 'main', nag_count: 0, next_run_at: null });
          }
        }
        await logScheduleRun(row.id, row.title, 'acked', 'подтверждено боссом');
        console.log(`[Schedule] acknowledge #${row.id} «${row.title}»`);
        return {
          success: true, id: row.id, title: row.title, acknowledged: true,
          next_run_local: nextLocal,
          note: nextLocal ? `Снято. Следующее срабатывание: ${nextLocal} (локальное).` : 'Напоминание снято.',
        };
      }

      // «Отложи на N минут» — сдвинуть ближайшее срабатывание (любая фаза).
      case 'snooze': {
        const n = Number(args.snooze_minutes);
        if (!Number.isInteger(n) || n < 1 || n > 1440) {
          return { success: false, message: 'snooze_minutes должен быть целым 1–1440 (на сколько минут отложить).' };
        }
        let row;
        if (args.id) {
          const r = await getOwned(args.id, context);
          if (r.err) return { success: false, message: r.err };
          row = r.row;
        } else {
          const waiting = await listAwaiting(context);
          if (waiting.length === 1) {
            row = waiting[0];
          } else if (waiting.length > 1) {
            return {
              success: false, message: 'Несколько напоминаний ждут подтверждения — укажи id.',
              waiting: waiting.map((r) => ({ id: r.id, title: r.title })),
            };
          } else {
            // Последнее сработавшее за час (отложить только что пришедшее напоминание).
            const all = await listSchedulesByOwner(context.channel, context.chatId, true);
            const recent = all
              .filter((r) => r.last_run_at && Date.now() - toUtc(r.last_run_at).getTime() < 60 * 60000)
              .sort((a, b) => toUtc(b.last_run_at).getTime() - toUtc(a.last_run_at).getTime());
            if (!recent.length) return { success: false, message: 'Не понял, какое напоминание отложить — укажи id (см. list).' };
            row = recent[0];
          }
        }
        const next = new Date(Date.now() + n * 60000);
        await updateSchedule(row.id, { enabled: 1, fail_count: 0, next_run_at: fmtUtc(next) });
        await logScheduleRun(row.id, row.title, 'snoozed', `отложено на ${n} мин`);
        console.log(`[Schedule] snooze #${row.id} «${row.title}» +${n}м`);
        return { success: true, id: row.id, title: row.title, next_run_local: utcToLocalStr(next), note: `Отложено на ${n} мин.` };
      }

      // Пропустить ближайшее вхождение регулярного расписания.
      case 'skip_next': {
        const { row, err } = await getOwned(args.id, context);
        if (err) return { success: false, message: err };
        if (!RECURRING_KINDS.includes(row.kind)) {
          return { success: false, message: 'skip_next только для регулярных. Для once используй update (перенос) или cancel.' };
        }
        if (row.fire_phase === 'nag') {
          return { success: false, message: 'Это напоминание ждёт подтверждения — сначала acknowledge.' };
        }
        if (!row.next_run_at) return { success: false, message: 'Нечего пропускать: следующий запуск не запланирован.' };
        // Ближайший основной момент: в фазе pre он впереди (восстановим), в main — это next_run_at.
        const mainAt = row.fire_phase === 'pre'
          ? computeNextRunAt(row, toUtc(row.next_run_at))
          : toUtc(row.next_run_at);
        if (!mainAt) return { success: false, message: 'Нечего пропускать: повторы уже исчерпаны.' };
        const nf = computeNextFire(row, mainAt); // строго после пропущенного вхождения
        if (!nf) {
          await updateSchedule(row.id, { enabled: 0, fire_phase: 'main', next_run_at: null });
          await logScheduleRun(row.id, row.title, 'skipped', `пропущено ${utcToLocalStr(mainAt)}; дальше повторов нет — завершено`);
          return { success: true, id: row.id, skipped_local: utcToLocalStr(mainAt), note: 'Пропущено; дальше повторов нет (until) — расписание завершено.' };
        }
        await updateSchedule(row.id, { next_run_at: fmtUtc(nf.at), fire_phase: nf.phase });
        await logScheduleRun(row.id, row.title, 'skipped', `пропущено вхождение ${utcToLocalStr(mainAt)}`);
        console.log(`[Schedule] skip_next #${row.id} «${row.title}»`);
        return { success: true, id: row.id, skipped_local: utcToLocalStr(mainAt), next_run_local: utcToLocalStr(nf.at) };
      }

      // Обзор ближайших срабатываний: «что у меня сегодня / завтра / на неделе».
      case 'agenda': {
        const horizon = ['today', 'tomorrow', 'week', 'all'].includes(args.horizon) ? args.horizon : 'today';
        const rows = await listSchedulesByOwner(context.channel, context.chatId, false);
        const now = new Date();
        const loc = localNow(now);
        // Конец локального дня (+plusDays) → UTC.
        const endOfLocalDay = (plusDays) => new Date(
          Date.UTC(loc.getUTCFullYear(), loc.getUTCMonth(), loc.getUTCDate() + plusDays + 1, 0, 0, 0)
          - config.SCHEDULER_TZ_OFFSET_MIN * 60000
        );
        let from = null, to = null;
        if (horizon === 'today') to = endOfLocalDay(0);
        else if (horizon === 'tomorrow') { from = endOfLocalDay(0); to = endOfLocalDay(1); }
        else if (horizon === 'week') to = endOfLocalDay(6);
        const items = rows
          .filter((r) => r.next_run_at)
          .map((r) => ({ r, at: toUtc(r.next_run_at) }))
          .filter(({ at }) => (!from || at.getTime() > from.getTime()) && (!to || at.getTime() <= to.getTime()))
          .sort((a, b) => a.at.getTime() - b.at.getTime())
          .map(({ r, at }) => ({
            id: r.id,
            title: r.title,
            fires_at_local: utcToLocalStr(at),
            time_left: fmtTimeLeft(at.getTime() - now.getTime()),
            when: describeWhen(r),
            phase_note: r.fire_phase === 'nag' ? 'ждёт подтверждения (будильник)'
              : (r.fire_phase === 'pre' ? 'ближайшее — пред-напоминание' : undefined),
          }));
        return {
          success: true, horizon, count: items.length, items,
          note: items.length ? 'Время в items — локальное; time_left уже посчитан, не пересчитывай.' : 'На этот горизонт ничего не запланировано.',
        };
      }

      default:
        return { success: false, message: `Неизвестное действие: ${args.action}` };
    }
  } catch (err) {
    return handleToolDbError(err);
  }
}

module.exports = { definition, handler };

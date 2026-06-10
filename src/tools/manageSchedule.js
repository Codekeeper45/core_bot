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
  setScheduleEnabled, deleteSchedule, countSchedules,
} = require('../services/mysql');
const { computeNextRunAt, toUtc, fmtUtc } = require('../utils/scheduleTime');
const { localNow } = require('../utils/localTime');
const { handleToolDbError } = require('../utils/toolError');
const config = require('../config');

const definition = {
  type: 'function',
  function: {
    name: 'manage_schedule',
    description:
      'Планировать СОБСТВЕННЫЕ действия на будущее (режим босса). Отложенные и регулярные задачи: '
      + '«завтра в 15:00 проверь план X и напиши Курбану», «каждый день в 9:00 — сводка мне», '
      + '«каждый понедельник напомни про планёрку». В момент срабатывания ты выполнишь instruction '
      + 'своим обычным циклом (доступны все инструменты). Действия: create / list / update / cancel / '
      + 'enable / run_now. ВСЁ ВРЕМЯ УКАЗЫВАЙ ЛОКАЛЬНОЕ (Казахстан, UTC+5) — как говорит босс, '
      + 'без пересчёта в UTC: run_at (once) и at_hour/at_minute (daily/weekly/monthly). '
      + 'weekdays: Пн=1..Вс=7. month_days: числа месяца. run_now вернёт инструкцию — выполни её '
      + 'сразу в этом же ответе. Не путай с manage_scheduler (тот — про фиксированные '
      + 'утреннюю/вечернюю рассылки).',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['create', 'list', 'update', 'cancel', 'enable', 'run_now'],
          description: 'Что сделать. enable — включить обратно выключенное/отменённое расписание.',
        },
        id: { type: 'integer', description: 'id расписания (для update/cancel/enable/run_now).' },
        title: { type: 'string', description: 'Короткое имя расписания (для create/update).' },
        instruction: { type: 'string', description: 'Что бот должен сделать в момент срабатывания (естественным языком).' },
        kind: {
          type: 'string',
          enum: ['once', 'daily', 'weekly', 'monthly', 'interval'],
          description: 'Тип расписания.',
        },
        run_at: { type: 'string', description: 'kind=once: момент в ЛОКАЛЬНОМ времени (UTC+5), формат YYYY-MM-DD HH:MM:SS.' },
        at_hour: { type: 'integer', description: 'daily/weekly/monthly: час 0–23 в локальном времени (UTC+5).' },
        at_minute: { type: 'integer', description: 'Минута 0–59 (по умолчанию 0).' },
        weekdays: { type: 'string', description: 'weekly: дни недели через запятую, Пн=1..Вс=7 (напр. «1,3,5»).' },
        month_days: { type: 'string', description: 'monthly: числа месяца через запятую (напр. «1,15»).' },
        interval_min: { type: 'integer', description: `interval: период в минутах (минимум ${config.SCHEDULE_MIN_INTERVAL_MIN}).` },
        include_disabled: { type: 'boolean', description: 'list: показать и выключенные расписания.' },
        delete: { type: 'boolean', description: 'cancel: true — удалить совсем (иначе мягко выключить, можно вернуть через enable).' },
      },
      required: ['action'],
    },
  },
};

const KIND_REQUIRED = {
  once: ['run_at'],
  daily: ['at_hour'],
  weekly: ['at_hour', 'weekdays'],
  monthly: ['at_hour', 'month_days'],
  interval: ['interval_min'],
};
// Поля, влияющие на время срабатывания: их правка перевзводит расписание.
const TIMING_FIELDS = ['kind', 'run_at', 'at_hour', 'at_minute', 'weekdays', 'month_days', 'interval_min'];

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

function validateSpec(spec) {
  if (!spec.title) return 'Нужно title (короткое имя расписания).';
  if (!spec.instruction) return 'Нужно instruction (что сделать).';
  if (!spec.kind || !KIND_REQUIRED[spec.kind]) return 'Нужен корректный kind: once/daily/weekly/monthly/interval.';
  for (const f of KIND_REQUIRED[spec.kind]) {
    if (spec[f] === undefined || spec[f] === null || spec[f] === '') {
      return `Для kind=${spec.kind} нужно поле ${f}.`;
    }
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
  return null;
}

// Человекочитаемое описание «когда» — для list. Время — локальное.
function describeWhen(row) {
  const at = `${String(row.at_hour).padStart(2, '0')}:${String(row.at_minute || 0).padStart(2, '0')}`;
  switch (row.kind) {
    case 'once': return `разово ${utcToLocalStr(row.run_at)} (локальное время)`;
    case 'daily': return `каждый день в ${at}`;
    case 'weekly': return `по дням недели ${row.weekdays} в ${at}`;
    case 'monthly': return `по числам ${row.month_days} в ${at}`;
    case 'interval': return `каждые ${row.interval_min} мин`;
    default: return row.kind;
  }
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
        const err = validateSpec(args);
        if (err) return { success: false, message: err };
        const active = await countSchedules();
        if (active >= config.SCHEDULE_MAX_ACTIVE) {
          return { success: false, message: `Достигнут лимит активных расписаний (${config.SCHEDULE_MAX_ACTIVE}). Отмени ненужные (cancel) и повтори.` };
        }
        const warn = [];
        let runAtUtc = null;
        if (args.kind === 'once') {
          runAtUtc = localStrToUtc(args.run_at);
          if (!runAtUtc) return { success: false, message: 'run_at не распознан. Формат: YYYY-MM-DD HH:MM:SS (локальное время).' };
          if (runAtUtc.getTime() < Date.now() - 5 * 60000) {
            warn.push('run_at в прошлом — расписание сработает один раз сразу. Если это не задумано, проверь дату.');
          }
        }
        const spec = {
          title: args.title,
          instruction: args.instruction,
          kind: args.kind,
          run_at: runAtUtc ? fmtUtc(runAtUtc) : null,
          at_hour: ['daily', 'weekly', 'monthly'].includes(args.kind) ? Number(args.at_hour) : null,
          at_minute: ['daily', 'weekly', 'monthly'].includes(args.kind) ? (Number(args.at_minute) || 0) : null,
          weekdays: args.kind === 'weekly' ? String(args.weekdays) : null,
          month_days: args.kind === 'monthly' ? String(args.month_days) : null,
          interval_min: args.kind === 'interval' ? Number(args.interval_min) : null,
        };
        const next = computeNextRunAt(spec, new Date());
        const id = await createSchedule({
          owner_channel: context.channel,
          owner_chat_id: context.chatId,
          owner_phone: String(context.phone || '').replace(/\D/g, '') || null,
          ...spec,
          next_run_at: next ? fmtUtc(next) : null,
        });
        return {
          success: true, id, title: args.title, when: describeWhen(spec),
          next_run_local: next ? utcToLocalStr(next) : null, warnings: warn,
        };
      }

      case 'list': {
        const rows = await listSchedulesByOwner(context.channel, context.chatId, !!args.include_disabled);
        return {
          success: true,
          count: rows.length,
          schedules: rows.map((r) => ({
            id: r.id, title: r.title, when: describeWhen(r), enabled: !!r.enabled,
            next_run_local: utcToLocalStr(r.next_run_at),
            last_run_at: r.last_run_at, last_status: r.last_status,
          })),
        };
      }

      case 'update': {
        const { row, err } = await getOwned(args.id, context);
        if (err) return { success: false, message: err };
        const fields = {};
        for (const f of ['title', 'instruction', 'kind', 'at_hour', 'at_minute', 'weekdays', 'month_days', 'interval_min']) {
          if (args[f] !== undefined) fields[f] = args[f];
        }
        if (args.run_at !== undefined && args.run_at !== null && args.run_at !== '') {
          const t = localStrToUtc(args.run_at);
          if (!t) return { success: false, message: 'run_at не распознан. Формат: YYYY-MM-DD HH:MM:SS (локальное время).' };
          fields.run_at = fmtUtc(t);
        }
        if (!Object.keys(fields).length) return { success: false, message: 'Нет полей для обновления.' };
        // Валидируем ИТОГОВОЕ состояние (строка + правки), чтобы смена kind не оставила
        // расписание без обязательных полей — иначе оно молча перестанет срабатывать.
        const merged = { ...row, ...fields };
        const vErr = validateSpec(merged);
        if (vErr) return { success: false, message: vErr };
        // Правка времени перевзводит расписание: сбрасываем след прошлого запуска и
        // ошибки, включаем обратно — иначе перенесённое once никогда не сработает.
        if (TIMING_FIELDS.some((f) => fields[f] !== undefined)) {
          merged.last_run_at = null;
          const next = computeNextRunAt(merged, new Date());
          fields.next_run_at = next ? fmtUtc(next) : null;
          fields.last_run_at = null;
          fields.fail_count = 0;
          fields.enabled = 1;
        }
        const n = await updateSchedule(args.id, fields);
        return {
          success: n > 0, id: args.id, updated_fields: n,
          next_run_local: fields.next_run_at ? utcToLocalStr(fields.next_run_at) : utcToLocalStr(row.next_run_at),
        };
      }

      case 'cancel': {
        const { row, err } = await getOwned(args.id, context);
        if (err) return { success: false, message: err };
        if (args.delete) { await deleteSchedule(row.id); return { success: true, id: row.id, deleted: true }; }
        await setScheduleEnabled(row.id, false);
        return { success: true, id: row.id, disabled: true, note: 'Можно вернуть действием enable.' };
      }

      case 'enable': {
        const { row, err } = await getOwned(args.id, context);
        if (err) return { success: false, message: err };
        const next = computeNextRunAt({ ...row, last_run_at: row.kind === 'once' ? row.last_run_at : null }, new Date());
        if (!next) {
          return { success: false, message: 'Это once-расписание уже выполнено — обнови run_at (update), чтобы запланировать заново.' };
        }
        await updateSchedule(row.id, { enabled: 1, fail_count: 0, next_run_at: fmtUtc(next) });
        return { success: true, id: row.id, enabled: true, next_run_local: utcToLocalStr(next) };
      }

      case 'run_now': {
        const { row, err } = await getOwned(args.id, context);
        if (err) return { success: false, message: err };
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

      default:
        return { success: false, message: `Неизвестное действие: ${args.action}` };
    }
  } catch (err) {
    return handleToolDbError(err);
  }
}

module.exports = { definition, handler };

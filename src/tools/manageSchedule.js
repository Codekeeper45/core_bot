'use strict';
// Планирование собственных действий ИИ: отложенные (once) и регулярные (daily/weekly/
// monthly/interval) задачи. В момент срабатывания scheduledRunner выполнит instruction
// через обычный агентный цикл (доступны все инструменты). Только режим БОССА (BOSS_ONLY).
const {
  createSchedule, listSchedulesByOwner, getSchedule, updateSchedule,
  setScheduleEnabled, deleteSchedule,
} = require('../services/mysql');
const { handleToolDbError } = require('../utils/toolError');

const definition = {
  type: 'function',
  function: {
    name: 'manage_schedule',
    description:
      'Планировать СОБСТВЕННЫЕ действия на будущее (режим босса). Отложенные и регулярные задачи: '
      + '«завтра в 15:00 проверь план X и напиши Курбану», «каждый день в 9:00 — сводка мне», '
      + '«каждый понедельник напомни про планёрку». В момент срабатывания ты выполнишь instruction '
      + 'своим обычным циклом (доступны все инструменты). Действия: create / list / update / cancel / '
      + 'run_now. ВРЕМЯ: для kind=once указывай run_at в UTC (YYYY-MM-DD HH:MM:SS) — пересчитай '
      + 'локальное время (Казахстан UTC+5) в UTC сам, опираясь на текущий UTC из системного штампа. '
      + 'Для daily/weekly/monthly указывай at_hour/at_minute в ЛОКАЛЬНОМ времени (UTC+5) без '
      + 'пересчёта. weekdays: Пн=1..Вс=7. month_days: числа месяца. Не путай с manage_scheduler '
      + '(тот — про фиксированные утреннюю/вечернюю рассылки).',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['create', 'list', 'update', 'cancel', 'run_now'],
          description: 'Что сделать.',
        },
        id: { type: 'integer', description: 'id расписания (для update/cancel/run_now).' },
        title: { type: 'string', description: 'Короткое имя расписания (для create/update).' },
        instruction: { type: 'string', description: 'Что бот должен сделать в момент срабатывания (естественным языком).' },
        kind: {
          type: 'string',
          enum: ['once', 'daily', 'weekly', 'monthly', 'interval'],
          description: 'Тип расписания.',
        },
        run_at: { type: 'string', description: 'kind=once: момент в UTC, формат YYYY-MM-DD HH:MM:SS.' },
        at_hour: { type: 'integer', description: 'daily/weekly/monthly: час 0–23 в локальном времени (UTC+5).' },
        at_minute: { type: 'integer', description: 'Минута 0–59 (по умолчанию 0).' },
        weekdays: { type: 'string', description: 'weekly: дни недели через запятую, Пн=1..Вс=7 (напр. «1,3,5»).' },
        month_days: { type: 'string', description: 'monthly: числа месяца через запятую (напр. «1,15»).' },
        interval_min: { type: 'integer', description: 'interval: период в минутах (>=1).' },
        include_disabled: { type: 'boolean', description: 'list: показать и выключенные расписания.' },
        delete: { type: 'boolean', description: 'cancel: true — удалить совсем (иначе мягко выключить).' },
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

function validateCreate(args) {
  if (!args.title) return 'Нужно title (короткое имя расписания).';
  if (!args.instruction) return 'Нужно instruction (что сделать).';
  if (!args.kind || !KIND_REQUIRED[args.kind]) return 'Нужен корректный kind: once/daily/weekly/monthly/interval.';
  for (const f of KIND_REQUIRED[args.kind]) {
    if (args[f] === undefined || args[f] === null || args[f] === '') {
      return `Для kind=${args.kind} нужно поле ${f}.`;
    }
  }
  if (['daily', 'weekly', 'monthly'].includes(args.kind)) {
    const h = Number(args.at_hour);
    if (!Number.isInteger(h) || h < 0 || h > 23) return 'at_hour должен быть 0–23.';
    const m = args.at_minute === undefined ? 0 : Number(args.at_minute);
    if (!Number.isInteger(m) || m < 0 || m > 59) return 'at_minute должен быть 0–59.';
  }
  if (args.kind === 'interval' && (!Number.isInteger(Number(args.interval_min)) || Number(args.interval_min) < 1)) {
    return 'interval_min должен быть целым >= 1.';
  }
  return null;
}

// Человекочитаемое описание «когда» — для list.
function describeWhen(row) {
  const at = `${String(row.at_hour).padStart(2, '0')}:${String(row.at_minute || 0).padStart(2, '0')}`;
  switch (row.kind) {
    case 'once': return `разово ${row.run_at} UTC`;
    case 'daily': return `каждый день в ${at}`;
    case 'weekly': return `по дням недели ${row.weekdays} в ${at}`;
    case 'monthly': return `по числам ${row.month_days} в ${at}`;
    case 'interval': return `каждые ${row.interval_min} мин`;
    default: return row.kind;
  }
}

async function handler(args, context = {}) {
  try {
    switch (args.action) {
      case 'create': {
        const err = validateCreate(args);
        if (err) return { success: false, message: err };
        const warn = [];
        if (args.kind === 'once') {
          const t = new Date(String(args.run_at).replace(' ', 'T') + 'Z');
          if (isNaN(t.getTime())) return { success: false, message: 'run_at не распознан. Формат: YYYY-MM-DD HH:MM:SS (UTC).' };
          if (t.getTime() < Date.now() - 5 * 60000) {
            warn.push('run_at в прошлом — проверь часовой пояс (нужен UTC). Расписание сработает один раз сразу.');
          }
        }
        const id = await createSchedule({
          owner_channel: context.channel,
          owner_chat_id: context.chatId,
          owner_phone: String(context.phone || '').replace(/\D/g, '') || null,
          title: args.title,
          instruction: args.instruction,
          kind: args.kind,
          run_at: args.kind === 'once' ? String(args.run_at).replace('T', ' ').slice(0, 19) : null,
          at_hour: ['daily', 'weekly', 'monthly'].includes(args.kind) ? Number(args.at_hour) : null,
          at_minute: ['daily', 'weekly', 'monthly'].includes(args.kind) ? (Number(args.at_minute) || 0) : null,
          weekdays: args.kind === 'weekly' ? String(args.weekdays) : null,
          month_days: args.kind === 'monthly' ? String(args.month_days) : null,
          interval_min: args.kind === 'interval' ? Number(args.interval_min) : null,
        });
        return { success: true, id, title: args.title, when: describeWhen({ ...args, run_at: args.run_at }), warnings: warn };
      }

      case 'list': {
        const rows = await listSchedulesByOwner(context.channel, context.chatId, !!args.include_disabled);
        return {
          success: true,
          count: rows.length,
          schedules: rows.map((r) => ({
            id: r.id, title: r.title, when: describeWhen(r), enabled: !!r.enabled,
            last_run_at: r.last_run_at, last_status: r.last_status,
          })),
        };
      }

      case 'update': {
        if (!args.id) return { success: false, message: 'Нужен id расписания.' };
        const row = await getSchedule(args.id);
        if (!row) return { success: false, message: `Расписание #${args.id} не найдено.` };
        const fields = {};
        for (const f of ['title', 'instruction', 'kind', 'run_at', 'at_hour', 'at_minute', 'weekdays', 'month_days', 'interval_min']) {
          if (args[f] !== undefined) fields[f] = args[f];
        }
        if (args.run_at !== undefined && args.run_at) fields.run_at = String(args.run_at).replace('T', ' ').slice(0, 19);
        const n = await updateSchedule(args.id, fields);
        return { success: n > 0, id: args.id, updated_fields: n };
      }

      case 'cancel': {
        if (!args.id) return { success: false, message: 'Нужен id расписания.' };
        const row = await getSchedule(args.id);
        if (!row) return { success: false, message: `Расписание #${args.id} не найдено.` };
        if (args.delete) { await deleteSchedule(args.id); return { success: true, id: args.id, deleted: true }; }
        await setScheduleEnabled(args.id, false);
        return { success: true, id: args.id, disabled: true };
      }

      case 'run_now': {
        if (!args.id) return { success: false, message: 'Нужен id расписания.' };
        const row = await getSchedule(args.id);
        if (!row) return { success: false, message: `Расписание #${args.id} не найдено.` };
        const runner = require('../services/scheduledRunner');
        const res = await runner._internals.runSchedule(row, new Date());
        return { success: res === 'ok', id: args.id, result: res };
      }

      default:
        return { success: false, message: `Неизвестное действие: ${args.action}` };
    }
  } catch (err) {
    return handleToolDbError(err);
  }
}

module.exports = { definition, handler };

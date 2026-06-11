'use strict';
// Личные заметки и задачи босса (отдельно от orch_tasks для сотрудников). Лёгкий список.
// Режим босса (BOSS_ONLY). due у задач — в локальном времени компании (UTC+5).
const {
  addPersonalItem, listPersonalItems, setPersonalItemDone, deletePersonalItem,
} = require('../services/mysql');
const { toUtc, fmtUtc } = require('../utils/scheduleTime');
const { localNow } = require('../utils/localTime');
const config = require('../config');

// 'YYYY-MM-DD HH:MM[:SS]' локально → UTC DATETIME-строка (или null).
function localStrToUtc(s) {
  const m = String(s).trim().match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})(?::(\d{2}))?$/);
  if (!m) return null;
  const t = Date.parse(`${m[1]}T${m[2]}:${m[3] || '00'}Z`);
  if (isNaN(t)) return null;
  return fmtUtc(new Date(t - config.SCHEDULER_TZ_OFFSET_MIN * 60000));
}
function utcToLocalStr(v) {
  if (!v) return null;
  return localNow(toUtc(v)).toISOString().slice(0, 16).replace('T', ' ');
}

const notes = {
  definition: {
    type: 'function',
    function: {
      name: 'manage_notes',
      description:
        'Личные ЗАМЕТКИ босса (идеи, мысли, что не забыть). Действия: add (text), list, delete (id). '
        + 'Это памятки для себя, НЕ задачи сотрудникам.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['add', 'list', 'delete'] },
          text: { type: 'string', description: 'Текст заметки (для add).' },
          id: { type: 'integer', description: 'id заметки (для delete).' },
        },
        required: ['action'],
      },
    },
  },
  async handler(args, context = {}) {
    switch (args.action) {
      case 'add': {
        if (!args.text) return { success: false, message: 'Нужен text.' };
        const id = await addPersonalItem(context.channel, context.chatId, 'note', args.text, null);
        return { success: true, id, note: 'Заметка сохранена.' };
      }
      case 'list': {
        const rows = await listPersonalItems(context.channel, context.chatId, 'note');
        return { success: true, count: rows.length, notes: rows.map((r) => ({ id: r.id, text: r.text })) };
      }
      case 'delete': {
        if (!args.id) return { success: false, message: 'Нужен id.' };
        const ok = await deletePersonalItem(context.channel, context.chatId, args.id);
        return { success: ok, note: ok ? 'Удалено.' : 'Заметка не найдена.' };
      }
      default: return { success: false, message: `Неизвестное действие: ${args.action}` };
    }
  },
};

const todos = {
  definition: {
    type: 'function',
    function: {
      name: 'manage_todos',
      description:
        'Личные ЗАДАЧИ босса (его собственный to-do, НЕ задачи сотрудникам — для тех есть '
        + 'create_project/assign_task). Действия: add (text, due?), list, done (id), delete (id). '
        + 'due — срок в ЛОКАЛЬНОМ времени (UTC+5), формат YYYY-MM-DD HH:MM. Если у задачи есть срок, '
        + 'предложи боссу поставить напоминание через manage_schedule.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['add', 'list', 'done', 'delete'] },
          text: { type: 'string', description: 'Текст задачи (для add).' },
          due: { type: 'string', description: 'Срок YYYY-MM-DD HH:MM локально (опц., для add).' },
          id: { type: 'integer', description: 'id задачи (для done/delete).' },
          include_done: { type: 'boolean', description: 'list: показать и выполненные.' },
        },
        required: ['action'],
      },
    },
  },
  async handler(args, context = {}) {
    switch (args.action) {
      case 'add': {
        if (!args.text) return { success: false, message: 'Нужен text.' };
        let dueUtc = null;
        if (args.due) {
          dueUtc = localStrToUtc(args.due);
          if (!dueUtc) return { success: false, message: 'due не распознан. Формат: YYYY-MM-DD HH:MM (локальное время).' };
        }
        const id = await addPersonalItem(context.channel, context.chatId, 'todo', args.text, dueUtc);
        return { success: true, id, due_local: dueUtc ? utcToLocalStr(dueUtc) : null, note: 'Задача добавлена.' };
      }
      case 'list': {
        const rows = await listPersonalItems(context.channel, context.chatId, 'todo', !!args.include_done);
        return {
          success: true,
          count: rows.length,
          todos: rows.map((r) => ({ id: r.id, text: r.text, done: !!r.done, due_local: utcToLocalStr(r.due) })),
        };
      }
      case 'done': {
        if (!args.id) return { success: false, message: 'Нужен id.' };
        const ok = await setPersonalItemDone(context.channel, context.chatId, args.id, true);
        return { success: ok, note: ok ? 'Отмечено выполненным.' : 'Задача не найдена.' };
      }
      case 'delete': {
        if (!args.id) return { success: false, message: 'Нужен id.' };
        const ok = await deletePersonalItem(context.channel, context.chatId, args.id);
        return { success: ok, note: ok ? 'Удалено.' : 'Задача не найдена.' };
      }
      default: return { success: false, message: `Неизвестное действие: ${args.action}` };
    }
  },
};

module.exports = { tools: [notes, todos] };

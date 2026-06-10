'use strict';
const {
  getTask, updateTaskStatus, recomputeProjectStatus, getEmployeeById, findEmployeeByContact,
} = require('../services/mysql');
const config = require('../config');
const notifier = require('../services/notifier');
const { handleToolDbError } = require('../utils/toolError');

const STATUS_RU = {
  in_progress: 'взял в работу', blocked: 'заблокирована', done: 'выполнена',
  todo: 'в очереди', reassign: 'на переназначение',
};

const definition = {
  type: 'function',
  function: {
    name: 'update_task',
    description:
      'Меняет статус подзадачи и/или записывает её результат. В режиме приёма отчёта от сотрудника '
      + '(когда сообщение пришло от зарегистрированного сотрудника) — фиксируй его прогресс этим '
      + 'инструментом, сопоставив сообщение с одной из его открытых задач. Босс может форсировать '
      + 'статус (например, reassign при блокировке).',
    parameters: {
      type: 'object',
      properties: {
        task_id: { type: 'integer', description: 'Реальный id задачи.' },
        status: {
          type: 'string',
          enum: ['todo', 'in_progress', 'blocked', 'done', 'reassign'],
          description: 'Новый статус задачи.',
        },
        result: { type: 'string', description: 'Результат/итог по задаче (если есть).' },
      },
      required: ['task_id', 'status'],
    },
  },
};

async function handler(args, context = {}) {
  try {
    const task = await getTask(args.task_id);
    if (!task) return { success: false, message: `Задача ${args.task_id} не найдена.` };

    // Авторизация: сотрудник может менять только СВОЮ задачу. Босс (не сотрудник
    // или номер из BOSS_CONTACTS) может форсировать статус любой задачи.
    // phone — запасной идентификатор для LID-режима WhatsApp.
    const chatDigits = String(context.chatId || '').replace(/\D/g, '');
    const phoneDigits = String(context.phone || '').replace(/\D/g, '');
    const forcedBoss = (chatDigits && config.BOSS_CONTACTS.includes(chatDigits))
      || (phoneDigits && config.BOSS_CONTACTS.includes(phoneDigits));
    if (!forcedBoss) {
      const sender = await findEmployeeByContact(context.channel, context.chatId)
        || (phoneDigits ? await findEmployeeByContact(context.channel, phoneDigits) : null);
      if (sender && task.assignee_id !== sender.id) {
        return { success: false, reason: 'not_owner', message: 'Эта задача закреплена не за вами.' };
      }
    }

    await updateTaskStatus(args.task_id, args.status, args.result);

    // Статус проекта — один агрегат (без гонки read-modify-write).
    const projectStatus = await recomputeProjectStatus(task.project_id);

    // Проактивно уведомляем босса (владельца проекта) о прогрессе сотрудника.
    // Не дублируем, если действие инициировал сам босс в своём же чате.
    try {
      let who = '';
      if (task.assignee_id) {
        const emp = await getEmployeeById(task.assignee_id);
        if (emp) who = emp.name;
      }
      const verb = STATUS_RU[args.status] || args.status;
      let msg = `🔔 ${who ? who + ': ' : ''}задача #${task.id} «${task.title}» — ${verb}.`;
      if (args.result) msg += `\nРезультат: ${String(args.result).slice(0, 400)}`;
      if (projectStatus === 'done') msg += `\n✅ План выполнен.`;
      if (projectStatus === 'blocked') msg += `\n⚠️ По плану есть блокер — нужно решение.`;
      notifier.notifyOwner(task.project_id, msg, context.chatId).catch(() => {});
    } catch (_) { /* уведомление некритично */ }

    return {
      success: true,
      task_id: args.task_id,
      status: args.status,
      project_id: task.project_id,
      project_status: projectStatus,
    };
  } catch (err) {
    return handleToolDbError(err);
  }
}

module.exports = { definition, handler };

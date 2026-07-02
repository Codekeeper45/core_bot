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
      + 'инструментом, сопоставив сообщение с одной из его открытых задач. Менять можно ЛЮБУЮ задачу '
      + '(общие планы — общее дело); при изменении чужой задачи руководитель уведомляется автоматически.',
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

    // Иерархии нет: менять можно любую задачу. Определяем отправителя только чтобы
    // понять, ЧУЖУЮ ли задачу он меняет — тогда босс уведомляется автоматически.
    // phone — запасной идентификатор для LID-режима WhatsApp.
    const chatDigits = String(context.chatId || '').replace(/\D/g, '');
    const phoneDigits = String(context.phone || '').replace(/\D/g, '');
    const forcedBoss = (chatDigits && config.BOSS_CONTACTS.includes(chatDigits))
      || (phoneDigits && config.BOSS_CONTACTS.includes(phoneDigits));
    let foreignTask = false;
    if (!forcedBoss) {
      const sender = await findEmployeeByContact(context.channel, context.chatId)
        || (phoneDigits ? await findEmployeeByContact(context.channel, phoneDigits) : null);
      foreignTask = !sender || task.assignee_id !== sender.id;
    }

    const changed = await updateTaskStatus(args.task_id, args.status, args.result, context);
    if (!changed) return { success: false, reason: 'not_found', message: `Задача ${args.task_id} не найдена.` };

    // Статус проекта — один агрегат (без гонки read-modify-write).
    const projectStatus = await recomputeProjectStatus(task.project_id);

    // Авто-продвижение DAG: задача завершена → сами рассылаем готовых преемников
    // (assignee есть, зависимости сняты, ещё не диспатчены). Гейт: завершённая
    // задача была диспатчена (task.dispatched=1) → план живой/утверждён, каскад
    // не разошлёт неутверждённый план.
    let autoDispatched = [];
    if (args.status === 'done' && task.dispatched) {
      try {
        const { dispatchReadySuccessors } = require('../services/dispatcher');
        autoDispatched = await dispatchReadySuccessors(task.project_id);
      } catch (e) {
        console.error('[updateTask] auto-dispatch:', e.message);
      }
    }

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
      if (autoDispatched.length) {
        msg += `\n➡️ Авто-запущены следующие шаги: `
          + autoDispatched.map((t) => `#${t.task_id} «${t.title}» → ${t.employee}`).join('; ');
      }
      notifier.notifyOwner(task.project_id, msg, context.chatId).catch(() => {});
      // Не-босс изменил ЧУЖУЮ задачу → прозрачность: боссу уходит уведомление
      // (владелец плана уже уведомлён notifyOwner — projectId дедупит).
      if (foreignTask && context.role !== 'boss') {
        const actor = context.clientName || context.phone || context.chatId || 'сотрудник';
        notifier.notifyBossAboutChange(
          context,
          `🔔 ${actor} изменил чужую задачу #${task.id} «${task.title}» → ${STATUS_RU[args.status] || args.status}.`,
          { projectId: task.project_id }
        ).catch(() => {});
      }
    } catch (_) { /* уведомление некритично */ }

    return {
      success: true,
      task_id: args.task_id,
      task_title: task.title, // чтобы боту было КАК назвать задачу человеку (не голым номером)
      status: args.status,
      project_id: task.project_id,
      project_status: projectStatus,
      auto_dispatched: autoDispatched,
    };
  } catch (err) {
    return handleToolDbError(err);
  }
}

module.exports = { definition, handler };

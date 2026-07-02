'use strict';

const {
  getTask, findEmployeeByContact, createTaskReport, recomputeProjectStatus,
} = require('../services/mysql');
const config = require('../config');
const notifier = require('../services/notifier');
const { handleToolDbError } = require('../utils/toolError');

const definition = {
  type: 'function',
  function: {
    name: 'task_report',
    description: 'Записывает структурированный отчёт строго по указанному task_id. Если из сообщения непонятно, о какой задаче речь, сначала попроси пользователя выбрать ID и не вызывай инструмент.',
    parameters: {
      type: 'object',
      properties: {
        task_id: { type: 'integer', description: 'Точный ID задачи.' },
        status: { type: 'string', enum: ['in_progress', 'blocked', 'done'] },
        comment: { type: 'string', description: 'Что сделано или текущее состояние.' },
        progress_percent: { type: 'integer', description: 'Прогресс 0–100.' },
        blocker: { type: 'string', description: 'Причина блокировки.' },
        next_step: { type: 'string', description: 'Следующее действие.' },
        eta: { type: 'string', description: 'Ожидаемое время завершения ISO 8601.' },
      },
      required: ['task_id', 'status', 'comment'],
    },
  },
};

async function handler(args, context = {}) {
  try {
    const task = await getTask(args.task_id);
    if (!task) return { success: false, reason: 'not_found', message: `Задача #${args.task_id} не найдена.` };
    // Иерархии нет: отчёт можно записать по любой задаче; по чужой — босс
    // уведомляется автоматически (прозрачность вместо запрета).
    const chatDigits = String(context.chatId || '').replace(/\D/g, '');
    const phoneDigits = String(context.phone || '').replace(/\D/g, '');
    const forcedBoss = (chatDigits && config.BOSS_CONTACTS.includes(chatDigits))
      || (phoneDigits && config.BOSS_CONTACTS.includes(phoneDigits));
    let foreignTask = false;
    if (!forcedBoss) {
      const sender = await findEmployeeByContact(context.channel, context.chatId)
        || (phoneDigits ? await findEmployeeByContact(context.channel, phoneDigits) : null);
      foreignTask = !sender || Number(task.assignee_id) !== Number(sender.id);
    }
    if (args.status === 'blocked' && !String(args.blocker || '').trim()) {
      return { success: false, reason: 'blocker_required', message: 'Для блокировки укажи причину.' };
    }
    const saved = await createTaskReport(args.task_id, args, context);
    if (!saved) return { success: false, reason: 'not_found', message: `Задача #${args.task_id} не найдена.` };
    const projectStatus = await recomputeProjectStatus(task.project_id);
    const text = `Отчёт по задаче #${task.id} «${task.title}»: ${args.status}.\n${String(args.comment).slice(0, 500)}`;
    notifier.notifyOwner(task.project_id, text, context.chatId).catch(() => {});
    if (foreignTask && context.role !== 'boss') {
      const actor = context.clientName || context.phone || context.chatId || 'сотрудник';
      notifier.notifyBossAboutChange(
        context,
        `🔔 ${actor} записал отчёт по чужой задаче #${task.id} «${task.title}» (${args.status}).`,
        { projectId: task.project_id }
      ).catch(() => {});
    }
    if (args.status === 'done' && task.dispatched) {
      require('../services/dispatcher').dispatchReadySuccessors(task.project_id).catch(() => {});
    }
    return {
      success: true,
      report_id: saved.report_id || null,
      task_id: task.id,
      task_title: task.title,
      status: args.status,
      project_id: task.project_id,
      project_status: projectStatus,
    };
  } catch (err) {
    return handleToolDbError(err);
  }
}

module.exports = { definition, handler };


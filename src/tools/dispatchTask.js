'use strict';
const { dispatchTaskById } = require('../services/dispatcher');
const { handleToolDbError } = require('../utils/toolError');
const { getTask, getProject } = require('../services/mysql');
const notifier = require('../services/notifier');

const definition = {
  type: 'function',
  function: {
    name: 'dispatch_task',
    description:
      'Отправляет подзадачу назначенному сотруднику в его канал и фиксирует диспатч. message — '
      + 'короткий, чёткий, actionable бриф (цель, что сделать, ожидаемый результат, дедлайн). '
      + 'Если у сотрудника нет реального контакта (тестовый сотрудник) — диспатч только записывается '
      + '(sent=false), сообщение физически не уходит. Диспатчи задачи без невыполненных зависимостей.',
    parameters: {
      type: 'object',
      properties: {
        task_id: { type: 'integer', description: 'Реальный id задачи.' },
        message: { type: 'string', description: 'Краткий бриф для сотрудника, без воды.' },
      },
      required: ['task_id', 'message'],
    },
  },
};

async function handler(args, context = {}) {
  try {
    const result = await dispatchTaskById(args.task_id, args.message, context);
    // Уведомление боссу только про РУЧНОЙ диспатч чужого плана не-боссом (здесь,
    // а не в dispatcher.js — авто-каскад dispatchReadySuccessors не должен спамить).
    if (result && result.success && context.role !== 'boss') {
      try {
        const task = await getTask(args.task_id);
        const project = task ? await getProject(task.project_id) : null;
        const foreign = project && String(project.owner_chat_id || '') !== String(context.chatId || '');
        if (task && foreign) {
          const actor = context.clientName || context.phone || context.chatId || 'сотрудник';
          notifier.notifyBossAboutChange(
            context,
            `🔔 ${actor} отправил в работу задачу #${task.id} «${task.title}» (план «${project.title}»).`,
            { projectId: task.project_id }
          ).catch(() => {});
        }
      } catch (_) { /* уведомление некритично */ }
    }
    return result;
  } catch (err) {
    return handleToolDbError(err);
  }
}

module.exports = { definition, handler };

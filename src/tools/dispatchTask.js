'use strict';
const { dispatchTaskById } = require('../services/dispatcher');
const { handleToolDbError } = require('../utils/toolError');

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
    return await dispatchTaskById(args.task_id, args.message, context);
  } catch (err) {
    return handleToolDbError(err);
  }
}

module.exports = { definition, handler };

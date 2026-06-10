'use strict';
const { getTask, getEmployeeById, markDispatched, listTasksForProject } = require('../services/mysql');
const { deliver } = require('../services/notifier');
const { unmetDeps } = require('../utils/deps');
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

async function handler(args) {
  try {
    const task = await getTask(args.task_id);
    if (!task) return { success: false, message: `Задача ${args.task_id} не найдена.` };
    if (!task.assignee_id) {
      return { success: false, task_id: args.task_id, reason: 'no_assignee', message: 'Сначала назначь исполнителя (assign_task).' };
    }

    // Гейт зависимостей: не диспатчим, пока предшественники не завершены (DAG/критический путь).
    const siblings = await listTasksForProject(task.project_id);
    const waiting = unmetDeps(task, siblings);
    if (waiting.length) {
      return {
        success: false, task_id: args.task_id, reason: 'blocked_by_deps', waiting_on: waiting,
        message: `Задача #${task.id} ждёт завершения зависимостей: ${waiting.map((id) => '#' + id).join(', ')}. Диспатч отложен.`,
      };
    }

    const emp = await getEmployeeById(task.assignee_id);
    if (!emp) return { success: false, message: `Сотрудник ${task.assignee_id} не найден.` };

    const message = `Задача #${task.id}: ${task.title}\n${args.message}`;

    // Тестовый сотрудник (нет канала/контакта) — только запись.
    if (!emp.channel || !emp.contact) {
      await markDispatched(args.task_id, false);
      return {
        task_id: args.task_id, dispatched: true, sent: false, employee: emp.name,
        note: 'тестовый сотрудник — диспатч записан, сообщение не отправлено',
      };
    }

    const ok = await deliver(emp.channel, emp.contact, message);
    await markDispatched(args.task_id, ok);
    return {
      task_id: args.task_id, dispatched: true, sent: ok, employee: emp.name,
      note: ok ? 'доставлено' : 'ошибка отправки (см. логи)',
    };
  } catch (err) {
    return handleToolDbError(err);
  }
}

module.exports = { definition, handler };

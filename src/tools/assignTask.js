'use strict';
const { getTask, getEmployeeById, assignTask, recomputeProjectStatus } = require('../services/mysql');
const { handleToolDbError } = require('../utils/toolError');

const definition = {
  type: 'function',
  function: {
    name: 'assign_task',
    description:
      'Назначает (или переназначает) подзадачу сотруднику. Используй для переназначения при '
      + 'блокировке/перегрузке исполнителя. При первичном создании назначение можно задавать прямо '
      + 'в create_project (assignee_id).',
    parameters: {
      type: 'object',
      properties: {
        task_id: { type: 'integer', description: 'Реальный id задачи.' },
        employee_id: { type: 'integer', description: 'id сотрудника-исполнителя.' },
      },
      required: ['task_id', 'employee_id'],
    },
  },
};

async function handler(args) {
  try {
    const task = await getTask(args.task_id);
    if (!task) return { success: false, message: `Задача ${args.task_id} не найдена.` };
    const emp = await getEmployeeById(args.employee_id);
    if (!emp) return { success: false, message: `Сотрудник ${args.employee_id} не найден.` };

    // Переназначение сбрасывает диспатч и при необходимости возвращает задачу в очередь.
    const newStatus = await assignTask(args.task_id, args.employee_id);
    // Пересчитываем статус проекта (например, был done → снова active после reopen).
    const projectStatus = await recomputeProjectStatus(task.project_id);

    const needsRedispatch = newStatus === 'todo' && task.status !== 'todo';
    return {
      success: true,
      task_id: args.task_id,
      task_title: task.title, // называй задачу человеку по сути, не по номеру
      assignee: { id: emp.id, name: emp.name },
      status: newStatus,
      project_status: projectStatus,
      needs_redispatch: needsRedispatch,
      note: needsRedispatch
        ? 'Задача возвращена в очередь — продиспатчи её новому исполнителю (dispatch_task).'
        : undefined,
    };
  } catch (err) {
    return handleToolDbError(err);
  }
}

module.exports = { definition, handler };

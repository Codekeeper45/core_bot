'use strict';
const {
  getProject, updateProjectPlan, createTasksBulk, assignTask, getTask, getEmployeeById,
  updateTaskFields, updateTaskStatus, recomputeProjectStatus,
} = require('../services/mysql');
const { handleToolDbError } = require('../utils/toolError');

const definition = {
  type: 'function',
  function: {
    name: 'revise_project',
    description:
      'Пересмотреть/адаптировать план по фидбэку: обновить текст плана, добавить новые подзадачи, '
      + 'ИЗМЕНИТЬ существующие (название/описание/ожидаемое/срок/приоритет), переназначить или '
      + 'ОТМЕНИТЬ задачи. Используй, когда босс правит план ИЛИ когда сотрудник сообщил об изменении '
      + '(клиент передумал, нет товара, поменялось количество) и босс подтвердил адаптацию. '
      + 'Не спорь — адаптируй план под реальность.',
    parameters: {
      type: 'object',
      properties: {
        project_id: { type: 'integer', description: 'id плана.' },
        note: { type: 'string', description: 'Суть возражения/фидбэка босса (будет сохранена в память).' },
        plan: { type: 'string', description: 'Опционально: новый текст плана выполнения.' },
        add_tasks: {
          type: 'array',
          description: 'Опционально: новые подзадачи (как в create_project).',
          items: {
            type: 'object',
            properties: {
              ref: { type: 'string' },
              title: { type: 'string' },
              description: { type: 'string' },
              expected: { type: 'string' },
              priority: { type: 'integer' },
              depends_on: { type: 'array', items: { type: 'string' } },
              assignee_id: { type: 'integer' },
            },
            required: ['ref', 'title'],
          },
        },
        reassign: {
          type: 'array',
          description: 'Опционально: переназначения [{task_id, employee_id}].',
          items: {
            type: 'object',
            properties: {
              task_id: { type: 'integer' },
              employee_id: { type: 'integer' },
            },
            required: ['task_id', 'employee_id'],
          },
        },
        edit_tasks: {
          type: 'array',
          description: 'Опционально: правка существующих задач (клиент передумал, поменялось '
            + 'количество/срок). Меняй только переданные поля.',
          items: {
            type: 'object',
            properties: {
              task_id: { type: 'integer' },
              title: { type: 'string' },
              description: { type: 'string' },
              expected: { type: 'string' },
              priority: { type: 'integer' },
              deadline: { type: 'string', description: 'ISO дата-время или текст срока.' },
            },
            required: ['task_id'],
          },
        },
        cancel_tasks: {
          type: 'array',
          description: 'Опционально: отменить задачи (стали не нужны). [{task_id, reason}].',
          items: {
            type: 'object',
            properties: {
              task_id: { type: 'integer' },
              reason: { type: 'string' },
            },
            required: ['task_id'],
          },
        },
      },
      required: ['project_id', 'note'],
    },
  },
};

async function handler(args, context) {
  try {
    const project = await getProject(args.project_id);
    if (!project) return { success: false, message: `План ${args.project_id} не найден.` };

    const result = {
      success: true, project_id: args.project_id, plan_updated: false,
      added: [], reassigned: [], edited: [], cancelled: [], warnings: [],
    };

    if (args.plan) {
      await updateProjectPlan(args.project_id, args.plan);
      result.plan_updated = true;
    }

    if (Array.isArray(args.add_tasks) && args.add_tasks.length) {
      const added = await createTasksBulk(args.project_id, args.add_tasks);
      result.added = added.map((t) => ({ ref: t.ref, id: t.id, title: t.title }));
      if (added.warnings && added.warnings.length) result.warnings.push(...added.warnings);
    }

    for (const r of (Array.isArray(args.reassign) ? args.reassign : [])) {
      const task = await getTask(r.task_id);
      const emp = await getEmployeeById(r.employee_id);
      if (task && emp) {
        const newStatus = await assignTask(r.task_id, r.employee_id);
        result.reassigned.push({ task_id: r.task_id, employee: emp.name, status: newStatus });
      } else {
        result.warnings.push(`reassign: задача #${r.task_id} или сотрудник #${r.employee_id} не найдены`);
      }
    }

    for (const e of (Array.isArray(args.edit_tasks) ? args.edit_tasks : [])) {
      const task = await getTask(e.task_id);
      if (!task) { result.warnings.push(`edit: задача #${e.task_id} не найдена`); continue; }
      const ok = await updateTaskFields(e.task_id, {
        title: e.title, description: e.description, expected: e.expected,
        priority: e.priority, deadline: e.deadline,
      });
      if (ok) result.edited.push({ task_id: e.task_id });
      else result.warnings.push(`edit: для #${e.task_id} не передано ни одного поля`);
    }

    for (const c of (Array.isArray(args.cancel_tasks) ? args.cancel_tasks : [])) {
      const task = await getTask(c.task_id);
      if (!task) { result.warnings.push(`cancel: задача #${c.task_id} не найдена`); continue; }
      // Отмена = закрыть как done с пометкой (rollup и DAG это корректно учитывают).
      await updateTaskStatus(c.task_id, 'done', `Отменена: ${c.reason || 'не требуется'}`);
      result.cancelled.push({ task_id: c.task_id });
    }

    // Если правили/отменяли задачи — пересчитать статус плана.
    if (result.edited.length || result.cancelled.length || result.reassigned.length || result.added.length) {
      result.project_status = await recomputeProjectStatus(args.project_id);
    }

    return result;
  } catch (err) {
    return handleToolDbError(err);
  }
}

module.exports = { definition, handler };

'use strict';
const {
  getProject, updateProjectPlan, createTasksBulk, assignTask, getTask, getEmployeeById,
} = require('../services/mysql');
const { handleToolDbError } = require('../utils/toolError');

const definition = {
  type: 'function',
  function: {
    name: 'revise_project',
    description:
      'Пересмотреть план по возражению/фидбэку босса: обновить текст плана, добавить новые '
      + 'подзадачи и/или переназначить существующие. Возражение сохраняется в память (boss_objection) '
      + 'для будущего планирования. Используй, когда босс не согласен с планом или просит '
      + 'перераспределить работу. Не спорь — адаптируй.',
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
      added: [], reassigned: [], warnings: [],
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
      }
    }

    return result;
  } catch (err) {
    return handleToolDbError(err);
  }
}

module.exports = { definition, handler };

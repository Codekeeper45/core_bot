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
      + 'ОТМЕНИТЬ задачи. Общие планы правит ЛЮБОЙ (клиент передумал, нет товара, поменялось '
      + 'количество) — когда чужой план меняет не-босс, руководитель уведомляется автоматически. '
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
    const belongsToProject = (task) => task && Number(task.project_id) === Number(args.project_id);

    if (args.plan) {
      result.plan_updated = await updateProjectPlan(args.project_id, args.plan);
    }

    if (Array.isArray(args.add_tasks) && args.add_tasks.length) {
      const added = await createTasksBulk(args.project_id, args.add_tasks, context);
      result.added = added.map((t) => ({ ref: t.ref, id: t.id, title: t.title }));
      if (added.warnings && added.warnings.length) result.warnings.push(...added.warnings);
    }

    for (const r of (Array.isArray(args.reassign) ? args.reassign : [])) {
      const task = await getTask(r.task_id);
      const emp = await getEmployeeById(r.employee_id);
      if (task && !belongsToProject(task)) {
        result.warnings.push(`reassign: задача #${r.task_id} принадлежит другому плану`);
      } else if (task && emp) {
        const newStatus = await assignTask(r.task_id, r.employee_id, context);
        result.reassigned.push({ task_id: r.task_id, task_title: task.title, employee: emp.name, status: newStatus });
      } else {
        result.warnings.push(`reassign: задача #${r.task_id} или сотрудник #${r.employee_id} не найдены`);
      }
    }

    for (const e of (Array.isArray(args.edit_tasks) ? args.edit_tasks : [])) {
      const task = await getTask(e.task_id);
      if (!task) { result.warnings.push(`edit: задача #${e.task_id} не найдена`); continue; }
      if (!belongsToProject(task)) { result.warnings.push(`edit: задача #${e.task_id} принадлежит другому плану`); continue; }
      const ok = await updateTaskFields(e.task_id, {
        title: e.title, description: e.description, expected: e.expected,
        priority: e.priority, deadline: e.deadline,
      }, context);
      if (ok) result.edited.push({ task_id: e.task_id, task_title: e.title || task.title });
      else result.warnings.push(`edit: для #${e.task_id} не передано ни одного поля`);
    }

    for (const c of (Array.isArray(args.cancel_tasks) ? args.cancel_tasks : [])) {
      const task = await getTask(c.task_id);
      if (!task) { result.warnings.push(`cancel: задача #${c.task_id} не найдена`); continue; }
      if (!belongsToProject(task)) { result.warnings.push(`cancel: задача #${c.task_id} принадлежит другому плану`); continue; }
      const changed = await updateTaskStatus(c.task_id, 'cancelled', `Отменена: ${c.reason || 'не требуется'}`, context);
      if (changed) result.cancelled.push({ task_id: c.task_id, task_title: task.title });
      else result.warnings.push(`cancel: задача #${c.task_id} не изменена`);
    }

    // Если правили/отменяли задачи — пересчитать статус плана.
    if (result.edited.length || result.cancelled.length || result.reassigned.length || result.added.length) {
      result.project_status = await recomputeProjectStatus(args.project_id);
    }

    // Не-босс ревизовал ЧУЖОЙ план и что-то реально поменял → одно сводное
    // уведомление боссу за весь вызов (не по каждой подзадаче).
    const changedAnything = result.plan_updated || result.added.length
      || result.reassigned.length || result.edited.length || result.cancelled.length;
    const foreignProject = String(project.owner_chat_id || '') !== String((context && context.chatId) || '');
    if (changedAnything && foreignProject && (!context || context.role !== 'boss')) {
      const actor = (context && (context.clientName || context.phone || context.chatId)) || 'сотрудник';
      const parts = [];
      if (result.plan_updated) parts.push('обновлён текст плана');
      if (result.added.length) parts.push(`добавлено задач: ${result.added.length}`);
      if (result.reassigned.length) parts.push(`переназначено: ${result.reassigned.length}`);
      if (result.edited.length) parts.push(`изменено: ${result.edited.length}`);
      if (result.cancelled.length) parts.push(`отменено: ${result.cancelled.length}`);
      require('../services/notifier').notifyBossAboutChange(
        context || {},
        `🔔 ${actor} пересмотрел план «${project.title}» (#${args.project_id}): ${parts.join(', ')}.\nПричина: ${String(args.note || '').slice(0, 300)}`,
        { projectId: args.project_id }
      ).catch(() => {});
    }

    return result;
  } catch (err) {
    return handleToolDbError(err);
  }
}

module.exports = { definition, handler };

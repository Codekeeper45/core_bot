'use strict';
const {
  getProject, listTasksForProject, listAllProjects,
} = require('../services/mysql');
const { unmetDeps } = require('../utils/deps');
const { handleToolDbError } = require('../utils/toolError');

const definition = {
  type: 'function',
  function: {
    name: 'project_status',
    description:
      'Возвращает текущий статус плана со всеми подзадачами (исполнитель, статус, результат, '
      + 'зависимости) и сводкой (счётчики по статусам, блокеры, невыполненные зависимости). '
      + 'Используй для контроля прогресса и для сборки итогового отчёта. Без project_id — вернёт '
      + 'ВСЕ планы в системе (любых владельцев и чатов) — босс админ и видит всё.',
    parameters: {
      type: 'object',
      properties: {
        project_id: { type: 'integer', description: 'id плана. Опусти, чтобы получить список планов.' },
      },
      required: [],
    },
  },
};

async function handler(args) {
  try {
    // Без project_id — ВСЕ планы системы (босс — админ, видит планы любых владельцев/чатов,
    // в т.ч. созданные до смены идентификатора чата или из другого канала).
    if (!args.project_id) {
      const projects = await listAllProjects();
      return {
        projects: projects.map((p) => ({
          id: p.id, title: p.title, status: p.status, created_at: p.created_at,
          source_channel: p.owner_channel, // откуда план был создан
        })),
      };
    }

    const project = await getProject(args.project_id);
    if (!project) return { success: false, message: `План ${args.project_id} не найден.` };

    const tasks = await listTasksForProject(args.project_id);
    const doneCount = tasks.filter((t) => t.status === 'done').length;

    const byStatus = {};
    const blocked = [];
    const unmetDependencies = [];
    for (const t of tasks) {
      byStatus[t.status] = (byStatus[t.status] || 0) + 1;
      if (t.status === 'blocked') blocked.push(t.id);
      const unmet = unmetDeps(t, tasks); // единый источник истины с dispatch_task
      if (unmet.length && t.status !== 'done' && t.status !== 'cancelled') unmetDependencies.push({ task_id: t.id, waiting_on: unmet });
    }

    return {
      project: {
        id: project.id, title: project.title, goal: project.goal,
        plan: project.plan || '', status: project.status,
      },
      tasks: tasks.map((t) => ({
        id: t.id, title: t.title, expected: t.expected || '',
        priority: t.priority, status: t.status,
        assignee: t.assignee_name || null, assignee_id: t.assignee_id,
        depends_on: t.depends_on || '', dispatched: !!t.dispatched, sent: !!t.sent,
        result: t.result || '',
      })),
      summary: {
        total: tasks.length,
        by_status: byStatus,
        blocked,
        unmet_dependencies: unmetDependencies,
        done: doneCount,
      },
    };
  } catch (err) {
    return handleToolDbError(err);
  }
}

module.exports = { definition, handler };

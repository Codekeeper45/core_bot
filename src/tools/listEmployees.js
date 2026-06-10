'use strict';
const { listEmployees, listOpenTasksBrief } = require('../services/mysql');

const definition = {
  type: 'function',
  function: {
    name: 'list_employees',
    description:
      'Возвращает реестр доступных сотрудников с их ролями, навыками и текущей нагрузкой: '
      + 'open_task_count + open_tasks (id, название, статус каждой открытой задачи). Вызывай это '
      + 'ДО распределения задач (выбрать исполнителей, сбалансировать нагрузку) и когда босс '
      + 'спрашивает, кто чем занят / просит разгрузить сотрудника — task_id из open_tasks сразу '
      + 'пригодны для update_task / assign_task. is_test=true — тестовый сотрудник без реального '
      + 'канала: задача будет записана, но физически не отправлена.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
};

const OPEN_TASKS_CAP = 10; // на сотрудника, чтобы не раздувать ответ

async function handler() {
  const [rows, openTasks] = await Promise.all([listEmployees(), listOpenTasksBrief()]);

  // Группируем открытые задачи по исполнителю (один запрос, без N+1).
  const byAssignee = new Map();
  for (const t of openTasks) {
    if (t.assignee_id == null) continue;
    const list = byAssignee.get(t.assignee_id) || [];
    if (list.length < OPEN_TASKS_CAP) {
      list.push({ id: t.id, title: t.title, project_id: t.project_id, status: t.status });
    }
    byAssignee.set(t.assignee_id, list);
  }

  return {
    employees: rows.map((e) => ({
      id: e.id,
      name: e.name,
      roles: e.roles,
      skills: e.skills || '',
      is_test: !e.contact,
      open_task_count: Number(e.open_task_count) || 0,
      open_tasks: byAssignee.get(e.id) || [],
    })),
    unassigned_open_tasks: openTasks
      .filter((t) => t.assignee_id == null)
      .slice(0, OPEN_TASKS_CAP)
      .map((t) => ({ id: t.id, title: t.title, project_id: t.project_id, status: t.status })),
  };
}

module.exports = { definition, handler };

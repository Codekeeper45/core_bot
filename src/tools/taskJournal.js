'use strict';

const { listTaskEvents } = require('../services/mysql');
const { handleToolDbError } = require('../utils/toolError');

const definition = {
  type: 'function',
  function: {
    name: 'task_journal',
    description: 'Показывает неизменяемую историю действий по конкретной задаче или плану: создание, отчёты, сроки, переназначения, завершение и отмену.',
    parameters: {
      type: 'object',
      properties: {
        task_id: { type: 'integer' },
        project_id: { type: 'integer' },
        limit: { type: 'integer', description: '1–100, по умолчанию 50.' },
      },
    },
  },
};

async function handler(args) {
  if (args.task_id == null && args.project_id == null) {
    return { success: false, reason: 'scope_required', message: 'Укажи task_id или project_id.' };
  }
  try {
    const events = await listTaskEvents({ taskId: args.task_id, projectId: args.project_id, limit: args.limit });
    return { success: true, count: events.length, events };
  } catch (err) {
    return handleToolDbError(err);
  }
}

module.exports = { definition, handler };


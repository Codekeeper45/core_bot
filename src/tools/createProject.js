'use strict';
const { createProject, createTasksBulk, setProjectStatus } = require('../services/mysql');

const definition = {
  type: 'function',
  function: {
    name: 'create_project',
    description:
      'Создаёт ПЛАН (большую задачу/цель) вместе с декомпозированными подзадачами '
      + 'выполнения за ОДИН вызов. Вызывай ПОСЛЕ анализа задачи и list_employees, когда scope ясен '
      + '(иначе сначала задай уточняющие вопросы). Каждой подзадаче дай ref (временный id, напр. "t1") '
      + 'для указания зависимостей внутри этого же вызова. Вернётся карта ref→реальный id задачи — '
      + 'используй реальные id для dispatch_task.',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Короткое название плана.' },
        goal: { type: 'string', description: 'Исходная цель/задача целиком, как её сформулировал босс.' },
        plan: {
          type: 'string',
          description:
            'План выполнения: порядок, критический путь, что можно делать параллельно, блокеры.',
        },
        tasks: {
          type: 'array',
          description: 'Декомпозированные подзадачи.',
          items: {
            type: 'object',
            properties: {
              ref: { type: 'string', description: 'Временный id задачи в этом вызове, напр. "t1".' },
              title: { type: 'string', description: 'Название подзадачи.' },
              description: { type: 'string', description: 'Что именно сделать.' },
              expected: { type: 'string', description: 'Ожидаемый результат / definition of done.' },
              priority: { type: 'integer', description: 'Приоритет 1 (высший) .. 5 (низший).' },
              deadline: {
                type: 'string',
                description: 'Срок выполнения в формате ISO 8601 (YYYY-MM-DDTHH:mm:ss).',
              },
              depends_on: {
                type: 'array',
                items: { type: 'string' },
                description: 'ref других подзадач из этого вызова, от которых зависит эта.',
              },
              assignee_id: { type: 'integer', description: 'id сотрудника-исполнителя (из list_employees).' },
            },
            required: ['ref', 'title'],
          },
        },
      },
      required: ['title', 'goal', 'tasks'],
    },
  },
};

async function handler(args, context) {
  const tasks = Array.isArray(args.tasks) ? args.tasks : [];
  if (!tasks.length) {
    return { success: false, message: 'tasks пуст — нечего создавать.' };
  }
  try {
    const projectId = await createProject(
      String(args.title || 'Без названия').slice(0, 255),
      String(args.goal || ''),
      args.plan || '',
      context.channel,
      context.chatId
    );
    const created = await createTasksBulk(projectId, tasks, context);
    const warnings = created.warnings || [];

    // План создан, но НЕ разослан: ждём утверждения босса (approval-first).
    await setProjectStatus(projectId, 'awaiting_approval');

    return {
      success: true,
      project_id: projectId,
      status: 'awaiting_approval',
      tasks: created.map((t) => ({ ref: t.ref, id: t.id, title: t.title })),
      warnings, // исправления плана (невалидный исполнитель / неизвестная связь / цикл) — сообщи боссу
      note: 'КРУПНАЯ задача: покажи план боссу и НЕ вызывай dispatch_task до его «утверждаю». '
        + 'ПРОСТАЯ повседневная задача (быстрый режим): можешь сразу диспатчить по реальным id, '
        + 'утверждения не жди.'
        + (warnings.length ? ' Сначала озвучь боссу предупреждения (warnings).' : ''),
    };
  } catch (err) {
    console.error('[CreateProject]', err && err.message);
    return { success: false, error: 'db', message: 'Не удалось создать план (сбой БД?). Попробуй ещё раз.' };
  }
}

module.exports = { definition, handler };

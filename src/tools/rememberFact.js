'use strict';
// Простая память: запоминать факты/предпочтения ПОЛЬЗОВАТЕЛЯ (босса или сотрудника)
// без векторов. Факты изолированы по (channel, chatId) и подмешиваются в системный
// промпт того же чата, так что бот «помнит» их в следующих сессиях именно с ним.
const { addFact, listFacts, deleteFact } = require('../services/mysql');

const remember = {
  definition: {
    type: 'function',
    function: {
      name: 'remember_fact',
      description:
        'Запомнить устойчивый факт/предпочтение или ОБЩЕЕ ПРАВИЛО поведения. Сохраняется навсегда. '
        + 'scope=personal (по умолчанию) — про ЭТОГО пользователя («не работает по пятницам», «жена — '
        + 'Айгуль»), видно только в его чате. scope=global — ПРАВИЛО ДЛЯ ВСЕХ ДИАЛОГОВ («со всеми '
        + 'сотрудниками общайся коротко и по делу», «после одного подтверждения не дёргать», «компания '
        + '— Neodrain»); применяется в каждом чате. Глобальные правила может задавать любой. Сохраняй '
        + 'сам, без лишних вопросов; НЕ запоминай разовое/сиюминутное.',
      parameters: {
        type: 'object',
        properties: {
          fact: { type: 'string', description: 'Факт/правило одной фразой, от третьего лица.' },
          category: { type: 'string', description: 'Категория: личное / бизнес / предпочтение / контакт (опц.).' },
          scope: { type: 'string', enum: ['personal', 'global'], description: 'personal = про этого пользователя (умолч.); global = правило для ВСЕХ диалогов.' },
        },
        required: ['fact'],
      },
    },
  },
  async handler(args, context = {}) {
    if (!args.fact) return { success: false, message: 'Нужен fact.' };
    const r = await addFact(context.channel, context.chatId, args.fact, args.category, args.scope);
    return {
      success: true, id: r.id, duplicate: r.duplicate, scope: r.scope,
      note: r.duplicate ? 'Уже было запомнено.' : (r.scope === 'global' ? 'Запомнил как общее правило (для всех).' : 'Запомнил.'),
    };
  },
};

const list = {
  definition: {
    type: 'function',
    function: {
      name: 'list_facts',
      description: 'Показать, что бот запомнил о пользователе (факты/предпочтения).',
      parameters: { type: 'object', properties: {} },
    },
  },
  async handler(args, context = {}) {
    const facts = await listFacts(context.channel, context.chatId, 50);
    return { success: true, count: facts.length, facts: facts.map((f) => ({ id: f.id, fact: f.fact, category: f.category, scope: f.scope || 'personal' })) };
  },
};

const forget = {
  definition: {
    type: 'function',
    function: {
      name: 'forget_fact',
      description: 'Забыть (удалить) запомненный факт — по id (из list_facts) или по совпадению текста.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'integer', description: 'id факта из list_facts.' },
          match: { type: 'string', description: 'Текст для поиска факта, если id неизвестен.' },
        },
      },
    },
  },
  async handler(args, context = {}) {
    if (!args.id && !args.match) return { success: false, message: 'Нужен id или match.' };
    const n = await deleteFact(context.channel, context.chatId, { id: args.id, match: args.match });
    return { success: n > 0, deleted: n, note: n ? 'Забыл.' : 'Такой факт не найден.' };
  },
};

// Реестр грузит ровно один {definition, handler} на файл — экспортируем три через under-tool.
// Чтобы не плодить файлы, экспортируем массив; index.js это не поддерживает → отдаём объект-список.
module.exports = { tools: [remember, list, forget] };

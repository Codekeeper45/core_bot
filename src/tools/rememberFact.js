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
        'Запомнить устойчивый ЛИЧНЫЙ факт или предпочтение текущего пользователя. Сохраняется надолго '
        + 'и видно только в его чате. Общие правила для всех через этот инструмент не сохраняй: '
        + 'используй manage_policy, где они проходят утверждение. Не запоминай разовое/сиюминутное.',
      parameters: {
        type: 'object',
        properties: {
          fact: { type: 'string', description: 'Факт/правило одной фразой, от третьего лица.' },
          category: { type: 'string', description: 'Категория: личное / бизнес / предпочтение / контакт (опц.).' },
          scope: { type: 'string', enum: ['personal'], description: 'Только personal. Общие правила — manage_policy.' },
        },
        required: ['fact'],
      },
    },
  },
  async handler(args, context = {}) {
    if (!args.fact) return { success: false, message: 'Нужен fact.' };
    if (args.scope === 'global') {
      return {
        success: false,
        reason: 'use_manage_policy',
        message: 'Общие правила сохраняются через manage_policy и требуют утверждения.',
      };
    }
    const r = await addFact(context.channel, context.chatId, args.fact, args.category, 'personal');
    return {
      success: true, id: r.id, duplicate: r.duplicate, scope: r.scope,
      note: r.duplicate ? 'Уже было запомнено.' : 'Запомнил как личный факт.',
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

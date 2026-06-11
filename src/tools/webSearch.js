'use strict';
// Веб-поиск в интернете для босса (Brave). Режим босса (BOSS_ONLY).
const { search } = require('../services/webSearch');

const definition = {
  type: 'function',
  function: {
    name: 'web_search',
    description:
      'Поиск актуальной информации в интернете (цены, новости, контакты компаний, факты, что угодно '
      + 'вне твоих знаний или свежее). Возвращает список результатов с заголовком, ссылкой и кратким '
      + 'описанием. Используй, когда нужны свежие/внешние данные. В ответе боссу ссылайся на источники.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Поисковый запрос.' },
        count: { type: 'integer', description: 'Сколько результатов (1–10, по умолчанию 5).' },
      },
      required: ['query'],
    },
  },
};

async function handler(args) {
  const r = await search(args.query, args.count);
  if (!r.ok) return { success: false, message: r.error };
  if (!r.results.length) return { success: true, results: [], note: 'Ничего не найдено.' };
  return {
    success: true,
    query: args.query,
    results: r.results,
    cached: r.cached || undefined,
  };
}

module.exports = { definition, handler };

'use strict';
// Семантический поиск по СОДЕРЖИМОМУ сохранённых файлов (база знаний).
// Фрагменты возвращаются с именем файла-источника — бот обязан его называть.
const fileKnowledge = require('../services/fileKnowledge');
const { handleToolDbError } = require('../utils/toolError');

const definition = {
  type: 'function',
  function: {
    name: 'search_files',
    description:
      'Семантический поиск ПО СОДЕРЖИМОМУ сохранённых файлов (база знаний: прайсы, договоры, '
      + 'инструкции, таблицы…). Находит по смыслу, даже если спросить другими словами. Вызывай, когда '
      + 'спрашивают «что в файле…», «найди в документах…», про данные/условия, которые могли быть в '
      + 'присланных файлах. В ответе пользователю ОБЯЗАТЕЛЬНО называй имя файла-источника каждого '
      + 'фрагмента. Приватные файлы других пользователей не ищутся (кроме руководителя). '
      + 'Список файлов — manage_files action=list.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Суть вопроса своими словами.' },
        file_name: { type: 'string', description: 'Искать только в этом файле (опционально).' },
        limit: { type: 'integer', description: 'Сколько фрагментов вернуть (1–15, по умолчанию 6).' },
      },
      required: ['query'],
    },
  },
};

async function handler(args, context = {}) {
  const query = String(args.query || '').trim();
  if (!query) return { success: false, reason: 'empty_query', message: 'Нужен запрос для поиска.' };
  try {
    const r = await fileKnowledge.searchFiles({
      channel: context.channel,
      chatId: context.chatId,
      role: context.role,
      query,
      fileName: args.file_name || null,
      limit: args.limit,
    });
    if (!r.ok) return { success: false, reason: r.reason, message: 'Не удалось выполнить поиск.' };
    const fragments = r.results.map((x) => ({
      file_name: x.file_name,
      owner_name: x.owner_name || null,
      chunk: x.seq,
      score: x.score == null ? null : Math.round(x.score * 1000) / 1000,
      text: String(x.content || '').slice(0, 1500),
    }));
    return {
      success: true,
      query,
      mode: r.mode,
      found: fragments.length,
      fragments,
      note: fragments.length
        ? 'В ответе называй файл-источник каждого фрагмента («по файлу … »). Не выдумывай данные, которых нет во фрагментах.'
        : 'Ничего не найдено. Проверь список файлов через manage_files list или уточни запрос.',
    };
  } catch (err) {
    return handleToolDbError(err);
  }
}

module.exports = { definition, handler };

'use strict';
// Долгая память: поиск по ПОЛНОМУ архиву переписки и журналу действий бота.
// Решает «бот ничего не помнит за пределами окна»: вся переписка пишется в
// bot_message_archive (не режется). Поиск СЕМАНТИЧЕСКИЙ (по смыслу, эмбеддинги) —
// находит даже другими словами; при отключённых эмбеддингах/пустом результате
// падаем на дословный поиск по ключевым словам.
const { recallSearch } = require('../services/mysql');
const { semanticRecall } = require('../services/memorySearch');
const { handleToolDbError } = require('../utils/toolError');

const definition = {
  type: 'function',
  function: {
    name: 'recall',
    description:
      'Поиск по ДОЛГОЙ ПАМЯТИ — полному архиву всей прошлой переписки и журналу действий бота, '
      + 'ПО СМЫСЛУ (находит, даже если спросить другими словами). Вызывай, когда просят вспомнить/'
      + 'найти что-то из прошлого, дать отчёт о событии или процессе («что было с… год назад», '
      + '«как шёл процесс…», «что мы обсуждали про…», «когда я пересылал…»). НЕ отвечай «не помню/не '
      + 'сохраняю историю», не выполнив поиск. В ответе у каждого фрагмента есть ДАТЫ — называй их '
      + 'точно и не путай. query — суть вопроса своими словами. scope: chat — текущий чат (по умолч.); '
      + 'all — по всем чатам (только босс; для переписки с другим человеком). kind: messages '
      + '(переписка, умолч.) / events (действия бота) / all.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Суть вопроса/тема своими словами (можно естественным языком).' },
        scope: { type: 'string', enum: ['chat', 'all'], description: 'chat — этот чат (умолч.); all — по всем чатам (только босс).' },
        kind: { type: 'string', enum: ['messages', 'events', 'all'], description: 'Что искать: переписку (умолч.), действия или всё.' },
        limit: { type: 'integer', description: 'Сколько фрагментов вернуть (1–25, по умолч. 8).' },
      },
      required: ['query'],
    },
  },
};

function fmtMsg(m) {
  const who = m.role === 'user' ? (m.actor_name || 'Пользователь') : 'Бот';
  return { when: m.created_at, who, chat: m.chat_id, text: String(m.content || '').slice(0, 1000) };
}
function fmtEvent(e) {
  return {
    when: e.created_at, tool: e.tool, action: e.action || null,
    by: e.actor_name || null, ok: e.success === 1 || e.success === true, summary: e.summary || null,
  };
}
function fmtChunk(c) {
  return {
    period: { from: c.first_at, to: c.last_at },
    authors: c.authors || null,
    chat: c.chat_id,
    score: Math.round((c.score || 0) * 1000) / 1000,
    text: String(c.content || '').slice(0, 4000),
  };
}

async function handler(args, context = {}) {
  const query = String(args.query || '').trim();
  if (!query) return { success: false, reason: 'empty_query', message: 'Нужны ключевые слова для поиска.' };
  // scope=all (по всем чатам) — только боссу: иначе сотрудник прочитал бы чужую
  // (в т.ч. боссовскую) переписку. Сотруднику молча сужаем до его чата.
  const scope = (args.scope === 'all' && context.role === 'boss') ? 'all' : 'chat';
  const kind = args.kind || 'messages';
  try {
    // 1) Семантика по переписке (если включена).
    let fragments = [];
    let mode = 'keyword';
    if (kind !== 'events') {
      try {
        const sem = await semanticRecall({ channel: context.channel, chatId: context.chatId, query, scope, limit: args.limit || 8 });
        if (sem.ok && sem.results.length) { fragments = sem.results.map(fmtChunk); mode = 'semantic'; }
        else if (sem.ok) mode = 'semantic'; // включено, но пусто → не падаем зря на LIKE
      } catch (e) { /* эмбеддинги недоступны — уйдём в LIKE ниже */ }
    }

    // 2) Дословный fallback: если семантика выключена/упала ИЛИ нужны events.
    let messages = [];
    let events = [];
    if (mode !== 'semantic' || kind === 'events' || kind === 'all') {
      const res = await recallSearch({
        channel: context.channel, chatId: context.chatId, query, scope,
        kind: mode === 'semantic' ? 'events' : kind, limit: args.limit,
      });
      messages = (res.messages || []).map(fmtMsg);
      events = (res.events || []).map(fmtEvent);
    }

    const found = fragments.length + messages.length + events.length;
    return {
      success: true,
      query,
      scope,
      mode,
      found,
      fragments,            // семантические фрагменты с датами (основное)
      messages,             // дословные совпадения (fallback)
      events,
      note: found ? undefined : 'В архиве по этому запросу ничего не найдено. Уточни формулировку или период.',
    };
  } catch (err) {
    return handleToolDbError(err);
  }
}

module.exports = { definition, handler };

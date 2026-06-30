'use strict';
// Точный поиск по архиву ПО ДАТАМ/ПЕРИОДУ (отдельно от смыслового recall).
// Модель сама выбирает промежуток from–to (время компании), инструмент забирает
// все сообщения в его пределах в хронологическом порядке. Опционально сужает по
// ключевым словам. Для вопросов «что было такого-то числа / за прошлый месяц /
// с… по…», точных отчётов и хронологий.
const { archiveByDateRange } = require('../services/mysql');
const { localBoundaryToUtc, localStamp } = require('../utils/localTime');
const { normKey } = require('../utils/stockKey');
const { handleToolDbError } = require('../utils/toolError');

const definition = {
  type: 'function',
  function: {
    name: 'recall_by_date',
    description:
      'Точная выборка переписки из архива ПО ДАТЕ/ПЕРИОДУ (дополняет смысловой recall). Сам выбери '
      + 'промежуток и передай его: from — начало, to — конец (по времени компании). Форматы: '
      + '«ГГГГ-ММ-ДД» или «ГГГГ-ММ-ДД ЧЧ:ММ». Один день → from и to = эта дата. «Прошлый месяц/год» '
      + 'посчитай от сегодняшней даты (она в системном штампе) и задай границы. to можно не указывать '
      + '(тогда до настоящего момента). query — опционально, чтобы сузить по словам внутри периода. '
      + 'Возвращает сообщения по возрастанию времени с точными датами — выстраивай по ним хронологию, '
      + 'даты бери строго из ответа. scope=all (по всем чатам) — только босс.',
    parameters: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'Начало периода: «ГГГГ-ММ-ДД» или «ГГГГ-ММ-ДД ЧЧ:ММ» (время компании).' },
        to: { type: 'string', description: 'Конец периода (вкл.). Если опущен — до настоящего момента.' },
        query: { type: 'string', description: 'Необязательно: ключевые слова для сужения внутри периода.' },
        scope: { type: 'string', enum: ['chat', 'all'], description: 'chat — этот чат (умолч.); all — по всем чатам (только босс).' },
        limit: { type: 'integer', description: 'Сколько сообщений вернуть (1–500, по умолч. 100).' },
      },
      required: ['from'],
    },
  },
};

async function handler(args, context = {}) {
  const fromUtc = localBoundaryToUtc(args.from, false);
  if (!fromUtc) return { success: false, reason: 'bad_from', message: 'Не понял дату начала. Формат: ГГГГ-ММ-ДД или ГГГГ-ММ-ДД ЧЧ:ММ.' };
  const toUtc = args.to ? localBoundaryToUtc(args.to, true) : new Date();
  if (!toUtc) return { success: false, reason: 'bad_to', message: 'Не понял дату конца. Формат: ГГГГ-ММ-ДД или ГГГГ-ММ-ДД ЧЧ:ММ.' };
  if (fromUtc.getTime() > toUtc.getTime()) return { success: false, reason: 'bad_range', message: 'Начало периода позже конца — поменяй from и to местами.' };

  const scope = (args.scope === 'all' && context.role === 'boss') ? 'all' : 'chat';
  const tokens = String(args.query || '').trim() ? normKey(args.query).split(' ').filter(Boolean).slice(0, 8) : [];
  const limit = Math.max(1, Math.min(Number(args.limit) || 100, 500));
  try {
    const rows = await archiveByDateRange({ channel: context.channel, chatId: context.chatId, scope, fromUtc, toUtc, tokens, limit });
    const messages = rows.map((m) => ({
      when: localStamp(m.created_at),
      who: m.role === 'user' ? (m.actor_name || 'Пользователь') : 'Бот',
      chat: m.chat_id,
      text: String(m.content || '').slice(0, 1500),
    }));
    return {
      success: true,
      scope,
      range: { from: localStamp(fromUtc), to: localStamp(toUtc) },
      count: messages.length,
      truncated: messages.length >= limit,
      messages,
      note: messages.length ? undefined : 'За этот период в архиве сообщений не найдено.',
    };
  } catch (err) {
    return handleToolDbError(err);
  }
}

module.exports = { definition, handler };

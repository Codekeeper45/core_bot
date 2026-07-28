'use strict';
// Чтение переписки КОНКРЕТНОГО человека с ботом: «покажи, что писал боту кладовщик
// Иван за сегодня». Резолвит человека из штата (findEmployees), забирает его диалог
// из архива по времени. Доступно всем; приватность — та же граница, что и в recall:
// не-босс не увидит человека, если тот пометил свой чат приватным (viewer → фильтр).
const { findEmployees, archiveByPerson } = require('../services/mysql');
const { localBoundaryToUtc, localStamp } = require('../utils/localTime');
const { queryTokens } = require('../utils/stockKey');
const { handleToolDbError } = require('../utils/toolError');

const definition = {
  type: 'function',
  function: {
    name: 'read_person',
    description:
      'Показать переписку КОНКРЕТНОГО человека из штата с ботом — что он писал и что бот отвечал. '
      + 'Вызывай на «покажи, что писал боту Иван», «переписка кладовщика за сегодня», «что спрашивал у '
      + 'бота Мякота». who — кого смотрим: имя / роль / id из штата (напр. «Иван», «кладовщик», «5»). '
      + 'Опц. from/to — период по времени компании («ГГГГ-ММ-ДД» или «ГГГГ-ММ-ДД ЧЧ:ММ»); без from — '
      + 'вся переписка (последние в пределах лимита). query — сузить по ключевым словам. Возвращает '
      + 'сообщения по времени с точными датами. Доступно всем; приватные чаты (manage_chat_privacy) '
      + 'видны только их владельцу и руководителю — чужой приватный чат не покажется.',
    parameters: {
      type: 'object',
      properties: {
        who: { type: 'string', description: 'Кого смотрим: имя / роль / id сотрудника (напр. «Иван», «кладовщик», «5»).' },
        from: { type: 'string', description: 'Начало периода: «ГГГГ-ММ-ДД» или «ГГГГ-ММ-ДД ЧЧ:ММ» (время компании). Опц.' },
        to: { type: 'string', description: 'Конец периода (вкл.). Если опущен — до настоящего момента. Опц.' },
        query: { type: 'string', description: 'Необязательно: ключевые слова, чтобы сузить внутри переписки.' },
        limit: { type: 'integer', description: 'Сколько сообщений вернуть (1–500, по умолч. 100).' },
        after_id: { type: 'integer', description: 'Курсор из next_after_id для следующей страницы.' },
      },
      required: ['who'],
    },
  },
};

async function handler(args, context = {}) {
  const who = String(args.who || '').trim();
  if (!who) return { success: false, reason: 'empty_who', message: 'Укажи who — чью переписку показать (имя/роль/id).' };

  // Границы периода: from опционально (пусто → с начала архива), to → до сейчас.
  const fromUtc = args.from ? localBoundaryToUtc(args.from, false) : null;
  if (args.from && !fromUtc) return { success: false, reason: 'bad_from', message: 'Не понял дату начала. Формат: ГГГГ-ММ-ДД или ГГГГ-ММ-ДД ЧЧ:ММ.' };
  const toUtc = args.to ? localBoundaryToUtc(args.to, true) : null;
  if (args.to && !toUtc) return { success: false, reason: 'bad_to', message: 'Не понял дату конца. Формат: ГГГГ-ММ-ДД или ГГГГ-ММ-ДД ЧЧ:ММ.' };
  if (fromUtc && toUtc && fromUtc.getTime() > toUtc.getTime()) {
    return { success: false, reason: 'bad_range', message: 'Начало периода позже конца — поменяй from и to местами.' };
  }

  try {
    const matches = await findEmployees(who);
    if (!matches.length) {
      return { success: false, reason: 'not_found', message: `В штате нет никого по запросу «${who}».` };
    }
    if (matches.length > 1) {
      return {
        success: false,
        reason: 'ambiguous',
        candidates: matches.map((m) => ({ id: m.id, name: m.name, roles: m.roles || null })),
        message: `Под «${who}» подходят несколько — уточни, кого смотреть (по имени или id).`,
      };
    }

    const emp = matches[0];
    const person = { channel: emp.channel, contact: emp.contact, name: emp.name };
    const viewer = { channel: context.channel, chatId: context.chatId, isBoss: context.role === 'boss' };
    const tokens = queryTokens(args.query || '').slice(0, 8);
    const limit = Math.max(1, Math.min(Number(args.limit) || 100, 500));

    const rows = await archiveByPerson({
      person,
      fromUtc,
      toUtc,
      tokens,
      limit: limit + 1,
      afterId: args.after_id,
      viewer,
    });
    const page = rows.slice(0, limit);
    const hasMore = rows.length > limit;
    const messages = page.map((r) => ({
      id: r.id,
      when: localStamp(r.created_at),
      who: r.role === 'user' ? (r.actor_name || emp.name) : 'Бот',
      message_type: r.message_type || 'legacy',
      origin: r.origin || 'legacy',
      source_message_id: r.source_message_id || null,
      media_id: r.media_id || null,
      reply_to_message_id: r.reply_to_message_id || null,
      text: String(r.content || '').slice(0, 1500),
    }));

    return {
      success: true,
      person: { id: emp.id, name: emp.name, roles: emp.roles || null },
      range: { from: fromUtc ? localStamp(fromUtc) : null, to: toUtc ? localStamp(toUtc) : null },
      count: messages.length,
      truncated: hasMore,
      next_after_id: hasMore && page.length ? page[page.length - 1].id : null,
      completeness: {
        complete: !hasMore,
        returned: messages.length,
        next_after_id: hasMore && page.length ? page[page.length - 1].id : null,
      },
      messages,
      note: messages.length
        ? undefined
        : 'Нет доступной переписки за этот период (либо чат помечен приватным — его видят только владелец и руководитель).',
    };
  } catch (err) {
    return handleToolDbError(err);
  }
}

module.exports = { definition, handler };

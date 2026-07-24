'use strict';

const { archiveChatPage, getObservedGroupAudio, saveObservedGroupAudioTranscript } = require('../services/mysql');
const { semanticRecall } = require('../services/memorySearch');
const { transcribeAudio } = require('../services/openrouterMedia');
const { localBoundaryToUtc, localStamp } = require('../utils/localTime');
const { queryTokens } = require('../utils/stockKey');
const { getObservedGroupIds, findObservedGroupId, isReportRequester } = require('../services/groupObserver');
const { handleToolDbError } = require('../utils/toolError');

const ARCHIVE_PAGE_MAX = 300;
const SEMANTIC_RESULT_MAX = 25;

const definition = {
  type: 'function',
  function: {
    name: 'group_report',
    description:
      'Полный поиск и отчёт по наблюдаемым WhatsApp-группам («Склад отгрузки», «Неодрейн Казахстан» / «Neodrain Kazakhstan» и др.). Используй в ЛС, когда '
      + 'Стас или руководитель просит сводку, историю, поиск сообщения или анализ группы. Группы read-only: бот только '
      + 'читает и архивирует сообщения, в саму группу никогда не отвечает. Голосовые сохраняются с '
      + 'транскрипцией, изображения — с описанием и извлечённым текстом. mode: audio — повторно '
      + 'расшифровать последнее или выбранное голосовое. mode: all — вся история '
      + 'постранично; date — точный период from/to; keyword — поиск точных слов по архиву; semantic — '
      + 'поиск по смыслу в эмбеддингах наблюдаемых групп. Для all/date/keyword при has_more=true '
      + 'обязательно вызови инструмент повторно с теми же параметрами и cursor=next_cursor, прежде чем '
      + 'составлять итоговый отчёт. Не выдумывай данные, даты бери из результата.',
    parameters: {
      type: 'object',
      properties: {
        group: { type: 'string', description: 'Название или JID наблюдаемой группы (например «Неодрейн Казахстан» или «Склад отгрузки»). Если не указано — поиск идёт по наблюдаемой группе.' },
        mode: {
          type: 'string',
          enum: ['all', 'date', 'keyword', 'semantic', 'audio'],
          description: 'Режим: all — вся история; date — период; keyword — точные слова; semantic — поиск по смыслу; audio — расшифровать голосовое.',
        },
        from: { type: 'string', description: 'Начало периода: ГГГГ-ММ-ДД или ГГГГ-ММ-ДД ЧЧ:ММ.' },
        to: { type: 'string', description: 'Конец периода включительно: ГГГГ-ММ-ДД или ГГГГ-ММ-ДД ЧЧ:ММ.' },
        query: { type: 'string', description: 'Запрос для keyword/semantic, например «задержка машины» или «сертификаты».' },
        audio_id: { type: 'integer', description: 'ID сохранённого голосового для mode=audio; без него берётся последнее подходящее.' },
        speaker: { type: 'string', description: 'Автор голосового для mode=audio, например «Заиндин».' },
        retry: { type: 'boolean', description: 'Для mode=audio: true — повторно отправить сохранённый оригинал в STT, даже если транскрипция уже есть.' },
        cursor: { type: 'integer', description: 'Курсор следующей страницы из next_cursor; начальная страница — 0.' },
        limit: { type: 'integer', description: 'Размер страницы/число семантических фрагментов: 1–300; по умолчанию 250.' },
      },
      required: [],
    },
  },
};

function defaultRecentRange() {
  const toUtc = new Date();
  return { fromUtc: new Date(toUtc.getTime() - 24 * 60 * 60 * 1000), toUtc };
}

function parseRange(args, mode) {
  const hasBoundary = !!(args.from || args.to);
  let range = (mode === 'date' && !hasBoundary) ? defaultRecentRange() : { fromUtc: null, toUtc: null };
  if (args.from) {
    range.fromUtc = localBoundaryToUtc(args.from, false);
    if (!range.fromUtc) return { error: { success: false, reason: 'bad_from', message: 'Не понял дату начала периода.' } };
  }
  if (args.to) {
    range.toUtc = localBoundaryToUtc(args.to, true);
    if (!range.toUtc) return { error: { success: false, reason: 'bad_to', message: 'Не понял дату конца периода.' } };
  }
  if (range.fromUtc && range.toUtc && range.fromUtc.getTime() > range.toUtc.getTime()) {
    return { error: { success: false, reason: 'bad_range', message: 'Начало периода позже конца.' } };
  }
  return { range };
}

function messageView(row) {
  return {
    when: localStamp(row.created_at),
    who: row.actor_name || 'Участник группы',
    text: String(row.content || '').slice(0, 2000),
  };
}

async function archivePage({ groupId, mode, range, query, cursor, pageSize }) {
  const tokens = query ? queryTokens(query).slice(0, 8) : [];
  const rows = await archiveChatPage({
    channel: 'whatsapp', chatId: groupId, afterId: cursor,
    fromUtc: range.fromUtc, toUtc: range.toUtc,
    tokens, limit: pageSize + 1,
  });
  const pageRows = rows.slice(0, pageSize);
  const hasMore = rows.length > pageSize;
  const nextCursor = hasMore && pageRows.length ? pageRows[pageRows.length - 1].id : null;
  const messages = pageRows.map(messageView);
  return {
    search_mode: mode,
    query: query || null,
    count: messages.length,
    messages,
    participants: [...new Set(messages.map((message) => message.who))],
    page: {
      cursor,
      page_size: pageSize,
      has_more: hasMore,
      next_cursor: nextCursor,
    },
  };
}

function rangeView(range) {
  return {
    from: range.fromUtc ? localStamp(range.fromUtc) : null,
    to: range.toUtc ? localStamp(range.toUtc) : null,
  };
}

async function semanticPage({ groupId, range, query, limit }) {
  const semantic = await semanticRecall({
    channel: 'whatsapp', chatId: groupId, scope: 'chat', query,
    limit: Math.min(limit, SEMANTIC_RESULT_MAX),
    fromUtc: range.fromUtc, toUtc: range.toUtc,
  });
  if (!semantic.ok) return { fallback: semantic.reason || 'semantic_unavailable' };
  const chunks = semantic.results.map((chunk) => ({
    score: Math.round((chunk.score || 0) * 1000) / 1000,
    period: { from: localStamp(chunk.first_at), to: localStamp(chunk.last_at) },
    authors: chunk.authors || null,
    message_count: chunk.msg_count || null,
    text: String(chunk.content || '').slice(0, 6000),
  }));
  return {
    search_mode: 'semantic',
    query,
    count: chunks.length,
    chunks,
    scanned: semantic.scanned,
    vector_search_truncated: !!semantic.truncated,
    page: { cursor: 0, page_size: chunks.length, has_more: false, next_cursor: null },
  };
}

async function audioReport({ groupId, range, args }) {
  const audioId = args.audio_id == null || args.audio_id === '' ? null : Number(args.audio_id);
  if (audioId != null && (!Number.isInteger(audioId) || audioId <= 0)) {
    return { success: false, reason: 'bad_audio_id', message: 'audio_id должен быть положительным целым числом.' };
  }
  const audio = await getObservedGroupAudio({
    channel: 'whatsapp', chatId: groupId, audioId,
    fromUtc: range.fromUtc, toUtc: range.toUtc, speaker: args.speaker || null,
  });
  if (!audio) {
    return { success: false, reason: 'audio_not_saved', message: 'Сохранённое голосовое за эти условия не найдено. Старые сообщения, пришедшие до включения хранения аудио, повторно расшифровать нельзя.' };
  }

  let transcript = String(audio.transcript || '').trim();
  if (args.retry === true || !transcript) {
    try {
      transcript = await transcribeAudio(audio.audio_data, audio.mime_type || 'audio/ogg');
      if (!transcript) throw new Error('empty_transcript');
      await saveObservedGroupAudioTranscript(audio.id, transcript);
    } catch (err) {
      return {
        success: false, reason: 'audio_transcription_failed', audio_id: audio.id,
        message: 'Оригинал голосового найден, но STT не вернул транскрипцию. Его можно попробовать снова позже.',
      };
    }
  }

  return {
    success: true, group: 'Склад отгрузки', mode: 'audio',
    audio: { id: audio.id, when: localStamp(audio.created_at), who: audio.actor_name || 'Участник группы', transcript },
    note: 'Это транскрипция сохранённого оригинала голосового из наблюдаемой группы.',
  };
}

async function handler(args = {}, context = {}) {
  if (!isReportRequester(context)) {
    return { success: false, reason: 'not_allowed', message: 'Отчёт по наблюдаемой группе доступен только назначенному запросчику.' };
  }
  const groupIds = getObservedGroupIds();
  if (!groupIds.length) {
    return { success: false, reason: 'group_not_configured', message: 'Наблюдаемая группа не настроена.' };
  }

  let groupId = groupIds[0];
  let groupName = 'Наблюдаемая группа';
  if (args.group) {
    const foundJid = findObservedGroupId(args.group);
    if (foundJid) {
      groupId = foundJid;
      groupName = String(args.group).trim();
    } else {
      groupName = String(args.group).trim();
    }
  }

  const query = String(args.query || '').trim();
  const mode = args.mode || (query ? 'semantic' : (args.from || args.to ? 'date' : 'date'));
  if (!['all', 'date', 'keyword', 'semantic', 'audio'].includes(mode)) {
    return { success: false, reason: 'bad_mode', message: 'Режим должен быть all, date, keyword, semantic или audio.' };
  }
  if ((mode === 'keyword' || mode === 'semantic') && !query) {
    return { success: false, reason: 'query_required', message: `Для режима ${mode} нужен query.` };
  }

  const parsed = parseRange(args, mode);
  if (parsed.error) return parsed.error;
  const range = parsed.range;
  if (mode === 'audio') {
    try { return await audioReport({ groupId, range, args }); } catch (err) { return handleToolDbError(err); }
  }
  const cursor = args.cursor == null || args.cursor === '' ? 0 : Number(args.cursor);
  if (!Number.isInteger(cursor) || cursor < 0) {
    return { success: false, reason: 'bad_cursor', message: 'cursor должен быть неотрицательным целым числом.' };
  }
  const requestedLimit = Math.max(1, Math.min(Number(args.limit) || 250, ARCHIVE_PAGE_MAX));

  try {
    let result;
    let fallbackReason = null;
    if (mode === 'semantic') {
      if (cursor) return { success: false, reason: 'cursor_not_supported', message: 'Для semantic курсор не нужен.' };
      result = await semanticPage({ groupId, range, query, limit: requestedLimit });
      if (result.fallback || result.count === 0) {
        fallbackReason = result.fallback || 'semantic_empty';
        result = await archivePage({ groupId, mode: 'keyword_fallback', range, query, cursor: 0, pageSize: requestedLimit });
      }
    } else {
      result = await archivePage({ groupId, mode, range, query, cursor, pageSize: requestedLimit });
    }

    const hasMore = !!result.page?.has_more;
    return {
      success: true,
      group: groupName,
      range: rangeView(range),
      mode,
      fallback_reason: fallbackReason,
      ...result,
      note: hasMore
        ? `Есть следующая страница. Обязательно повтори group_report с cursor=${result.page.next_cursor}, затем объединяй факты.`
        : (result.count || result.chunks?.length
          ? 'Это фактические данные архива группы. Отдели подтверждённые факты от нерешённых вопросов.'
          : 'За заданные условия сообщений не найдено.'),
    };
  } catch (err) {
    return handleToolDbError(err);
  }
}

module.exports = { definition, handler, _internals: { defaultRecentRange, parseRange, rangeView } };

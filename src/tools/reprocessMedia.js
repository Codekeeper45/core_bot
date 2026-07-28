'use strict';

const { getMedia, updateMediaDerived } = require('../services/mysql');
const {
  transcribeAudio, analyzeImageBase64, analyzeVideoBase64,
} = require('../services/openrouterMedia');
const { parseDocumentBuffer } = require('../media/document');
const { handleToolDbError } = require('../utils/toolError');

const definition = {
  type: 'function',
  function: {
    name: 'reprocess_media',
    description:
      'Повторно обработать СОХРАНЁННЫЙ оригинал голосового, изображения, видео или документа. '
      + 'Вызывай только когда пользователь явно просит повторить распознавание либо исходная обработка '
      + 'завершилась ошибкой. Для обычного запроса используй уже сохранённый derived_text из recall.',
    parameters: {
      type: 'object',
      properties: {
        media_id: { type: 'integer', description: 'ID медиа из recall.' },
        source_message_id: { type: 'string', description: 'ID исходного сообщения, если media_id неизвестен.' },
      },
      required: [],
    },
  },
};

async function handler(args = {}, context = {}) {
  try {
    if (!args.media_id && !args.source_message_id) {
      return { success: false, reason: 'media_required', message: 'Нужен media_id или source_message_id.' };
    }
    const media = await getMedia({
      id: args.media_id || null,
      channel: args.media_id ? null : context.channel,
      chatId: args.media_id ? null : context.chatId,
      sourceMessageId: args.source_message_id || null,
    });
    if (!media) return { success: false, reason: 'not_found', message: 'Сохранённое медиа не найдено.' };
    if (!media.media_data) {
      return {
        success: false,
        reason: 'original_expired',
        media_id: media.id,
        derived_text: media.derived_text || null,
        message: 'Срок хранения оригинала истёк. Сохранённый результат можно использовать, но повторная обработка невозможна.',
      };
    }

    let derived;
    const mime = media.mime_type || 'application/octet-stream';
    if (media.kind === 'voice' || media.kind === 'audio') {
      derived = await transcribeAudio(media.media_data, mime);
    } else if (media.kind === 'image' || media.kind === 'sticker') {
      derived = await analyzeImageBase64(
        media.media_data.toString('base64'),
        mime.startsWith('image/') ? mime : 'image/jpeg',
        'Опиши изображение и извлеки весь различимый текст, числа и даты. Не додумывай неразборчивое.'
      );
    } else if (['video', 'video_note', 'animation'].includes(media.kind)) {
      derived = await analyzeVideoBase64(
        media.media_data.toString('base64'),
        mime.startsWith('video/') ? mime : 'video/mp4',
        'Опиши видео и извлеки различимый текст и факты. Не додумывай.'
      );
    } else if (media.kind === 'document') {
      const family = media.file_name ? require('../channels/normalize').getDocumentFamily(mime, media.file_name) : 'text';
      derived = await parseDocumentBuffer(media.media_data, family, media.file_name || 'document');
    } else {
      return { success: false, reason: 'unsupported_kind', message: `Повторная обработка типа ${media.kind} не поддерживается.` };
    }

    const text = String(derived || '').trim();
    if (!text) {
      await updateMediaDerived(media.id, media.derived_text, 'failed', 'empty_result');
      return { success: false, reason: 'empty_result', message: 'Повторная обработка не вернула результата.' };
    }
    await updateMediaDerived(media.id, text, 'ready', null);
    return {
      success: true,
      media_id: media.id,
      source_message_id: media.source_message_id,
      kind: media.kind,
      derived_text: text,
      evidence: { source: 'bot_media', media_id: media.id, sha256: media.sha256 },
      note: 'Сохранённый оригинал обработан повторно; новый результат записан.',
    };
  } catch (err) {
    try {
      if (args.media_id) await updateMediaDerived(args.media_id, null, 'failed', err.message);
    } catch (_) {}
    return handleToolDbError(err);
  }
}

module.exports = { definition, handler };

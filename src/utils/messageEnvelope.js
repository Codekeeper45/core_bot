'use strict';

const TYPE_LABELS = {
  text: 'текст',
  voice: 'голосовое',
  audio: 'аудио',
  image: 'изображение',
  document: 'документ',
  video: 'видео',
  video_note: 'видеокружок',
  animation: 'гифка',
  sticker: 'стикер',
};

function clean(value, max = 2000) {
  return String(value == null ? '' : value).trim().slice(0, max);
}

function archiveContent(message = {}) {
  const type = message.message_type || message.messageType || 'text';
  const content = clean(message.processed_text ?? message.content ?? message.message, 60000);
  if (type === 'voice' || type === 'audio') {
    const status = message.processing_status || message.processingStatus || 'ready';
    if (status !== 'ready') {
      return `[ГОЛОСОВОЕ]\nСтатус распознавания: ${status}.\n${content || 'Транскрипция отсутствует.'}`;
    }
    return `[ГОЛОСОВОЕ]\nТранскрипция: ${content}`;
  }
  if (type === 'image' && !/^\[ИЗОБРАЖЕНИЕ/i.test(content)) {
    return `[ИЗОБРАЖЕНИЕ]\n${content || 'Без подписи; описание не получено.'}`;
  }
  if (type === 'document' && !/^\[ИЗ ДОКУМЕНТА:/i.test(content)) {
    const name = clean(message.document_file_name || message.fileName || 'файл', 255);
    return `[ДОКУМЕНТ: ${name}]\n${content}`;
  }
  return content || `[${TYPE_LABELS[type] || type}]`;
}

function renderOne(message = {}, index = 0) {
  const type = message.message_type || message.messageType || 'text';
  const sourceId = clean(message.message_id || message.sourceMessageId || '', 255);
  const original = clean(message.original_message_type || message.originalMessageType || '', 32);
  const lines = [
    `[ВХОДЯЩЕЕ СООБЩЕНИЕ ${index + 1}]`,
    `Тип: ${TYPE_LABELS[type] || type}${original && original !== type ? ` (исходный: ${original})` : ''}`,
  ];
  if (sourceId) lines.push(`ID сообщения: ${sourceId}`);
  if (message.media_id || message.mediaId) lines.push(`ID сохранённого медиа: ${message.media_id || message.mediaId}`);
  const replyId = message.reply_to_message_id || message.replyToMessageId;
  if (replyId || message.reply_to_text || message.replyToText) {
    const replyType = message.reply_to_message_type || message.replyToMessageType || 'сообщение';
    lines.push(`Ответ на: ID ${replyId || 'неизвестен'}, тип ${TYPE_LABELS[replyType] || replyType}`);
    const quote = clean(message.reply_to_text || message.replyToText, 1500);
    if (quote) lines.push(`Цитата: ${quote}`);
  }
  lines.push('Содержимое:');
  lines.push(archiveContent(message));
  lines.push(`[КОНЕЦ СООБЩЕНИЯ ${index + 1}]`);
  return lines.join('\n');
}

function renderBatch(messages = []) {
  return (Array.isArray(messages) ? messages : []).map(renderOne).join('\n\n');
}

module.exports = { archiveContent, renderOne, renderBatch };

'use strict';
// Повторное скачивание ВХОДЯЩЕГО медиа по дескриптору (для пересылки forward_message).
// Дескриптор собирается в index.js из нормализованного сообщения и доходит до тула через
// context.incomingMedia. Здесь — единая точка скачивания по каналу-источнику, реюз тех же
// примитивов, что и в media/{image,voice,document}.js.
const baileys = require('../services/baileys');
const tgClient = require('../channels/telegram');
const wazzup = require('../services/wazzup');

// desc = { type:'image'|'document'|'voice', channel, ref, file_id, source_url,
//          baileys_media_obj, file_name, mime }
// → { buffer, mime, fileName }. Бросает понятную ошибку, если скачать нечем.
async function downloadIncoming(desc) {
  if (!desc || !desc.type) throw new Error('downloadIncoming: пустой дескриптор медиа');
  const channel = String(desc.channel || '').toLowerCase();
  const fileName = desc.file_name || defaultName(desc.type);

  if (channel === 'telegram') {
    const fileId = desc.file_id
      || (typeof desc.ref === 'string' && desc.ref.startsWith('tg:') ? desc.ref.slice(3) : null);
    if (!fileId) throw new Error('downloadIncoming(telegram): нет file_id');
    const { buffer } = await tgClient.downloadFile(fileId);
    return { buffer, mime: desc.mime || null, fileName };
  }

  if (channel === 'whatsapp') {
    if (!desc.baileys_media_obj) throw new Error('downloadIncoming(whatsapp): нет baileys_media_obj');
    const waType = desc.type === 'voice' ? 'audio' : desc.type; // image|audio|document
    const buffer = await baileys.downloadMedia(desc.baileys_media_obj, waType);
    return { buffer, mime: desc.mime || null, fileName };
  }

  if (channel === 'instagram') {
    const url = desc.source_url || desc.ref;
    if (!url) throw new Error('downloadIncoming(instagram): нет URL контента');
    const { buffer, mimeType } = await wazzup.downloadContent(url);
    return { buffer, mime: desc.mime || mimeType || null, fileName };
  }

  throw new Error(`downloadIncoming: неизвестный канал «${desc.channel}»`);
}

function defaultName(type) {
  if (type === 'image') return 'photo.jpg';
  if (type === 'voice') return 'voice.ogg';
  return 'файл';
}

module.exports = { downloadIncoming };

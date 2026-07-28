'use strict';
const { sleep } = require('../utils/helpers');
const config = require('../config');

// In-memory buffer — single process, no Redis needed
const buffers = new Map();

async function bufferAndCollect(chatId, msgData) {
  if (!buffers.has(chatId)) buffers.set(chatId, []);
  buffers.get(chatId).push(msgData);

  await sleep(config.BUFFER_WAIT);

  const entries = buffers.get(chatId) || [];
  const newerExists = entries.some(m => m.timestamp > msgData.timestamp);
  if (newerExists) return null;

  const sorted = [...entries].sort((a, b) => a.timestamp - b.timestamp);
  buffers.delete(chatId);

  const combinedMessage = sorted.map(m => m.content).filter(Boolean).join('\n');
  const bufferedImages = sorted
    .filter(m => m.img_url)
    .map((m, i) => ({
      index: i + 1,
      image_ref: m.img_url,
      caption: m.content,
      timestamp: m.timestamp,
      baileys_media_obj: m.baileys_media_obj || null,
    }));

  // Все вложения батча (фото+док+голос) — для пересылки forward_message.
  const bufferedMedia = sorted.map(m => m.media).filter(Boolean);

  return {
    combined_message: combinedMessage,
    messages: sorted.map((m) => m.envelope || {
      content: m.content,
      message_type: m.media && m.media.type ? m.media.type : 'text',
    }),
    buffered_images: bufferedImages,
    buffered_image_count: bufferedImages.length,
    has_buffered_images: bufferedImages.length > 0,
    buffered_media: bufferedMedia,
  };
}

module.exports = { bufferAndCollect };

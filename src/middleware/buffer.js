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

  return {
    combined_message: combinedMessage,
    buffered_images: bufferedImages,
    buffered_image_count: bufferedImages.length,
    has_buffered_images: bufferedImages.length > 0,
  };
}

module.exports = { bufferAndCollect };

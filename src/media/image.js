'use strict';
const { analyzeImageUrl, analyzeImageBase64 } = require('../services/openrouterMedia');
const { checkDailyCount, incrementDailyCount } = require('../services/mysql');
const tgClient = require('../channels/telegram');
const config = require('../config');

const VISION_PROMPT = `Опиши, что изображено на картинке. Если на изображении есть текст —
извлеки его. Если это документ, таблица или скриншот — кратко передай ключевую информацию
(суммы, даты, числа, названия). Отвечай кратко и по существу, на языке пользователя.`;

async function downloadImageBuffer(image, channel) {
  const { image_ref, baileys_media_obj } = image;
  if (image_ref === 'wa-baileys' && baileys_media_obj) {
    const baileys = require('../services/baileys');
    return { buffer: await baileys.downloadMedia(baileys_media_obj, 'image'), mimeType: 'image/jpeg' };
  }
  if (channel === 'telegram' && image_ref && image_ref.startsWith('tg:')) {
    const fileId = image_ref.replace('tg:', '');
    const { buffer } = await tgClient.downloadFile(fileId);
    return { buffer, mimeType: 'image/jpeg' };
  }
  if (channel === 'instagram' && image_ref) {
    const wazzup = require('../services/wazzup');
    const { buffer, mimeType } = await wazzup.downloadContent(image_ref);
    return { buffer, mimeType: mimeType && mimeType.startsWith('image/') ? mimeType : 'image/jpeg' };
  }
  if (image_ref && !image_ref.startsWith('tg:') && image_ref !== 'wa-baileys') {
    const response = await fetch(image_ref);
    if (!response.ok) throw new Error(`Image download failed: ${response.status}`);
    return { buffer: Buffer.from(await response.arrayBuffer()), mimeType: response.headers.get('content-type') || 'image/jpeg' };
  }
  throw new Error('No media source available for image');
}

async function describeImageBuffer(buffer, mimeType, caption = '') {
  const fullPrompt = `${VISION_PROMPT}\n\nПодпись клиента: ${caption || 'нет'}`;
  return analyzeImageBase64(buffer.toString('base64'), mimeType || 'image/jpeg', fullPrompt);
}

async function processImage(normalized) {
  const image = {
    image_ref: normalized.image_source || normalized.image_url || '',
    caption: normalized.image_caption || '',
    baileys_media_obj: normalized.baileys_media_obj || null,
  };
  try {
    const { buffer, mimeType } = await downloadImageBuffer(image, normalized.channel);
    let description = null;
    let error = null;
    try {
      description = await describeImageBuffer(buffer, mimeType, image.caption);
    } catch (err) {
      error = err.message;
      console.error('[Image] Analyze error:', err.message);
    }
    const text = `[ИЗОБРАЖЕНИЕ]\nПодпись: ${image.caption || 'нет'}\nОписание: ${description || 'не получено'}`;
    return {
      text,
      derivedText: description || image.caption || null,
      processingStatus: description ? 'ready' : 'failed',
      processingError: error || (description ? null : 'vision_empty'),
      buffer,
      mimeType,
    };
  } catch (err) {
    console.error('[Image] Download error:', err.message);
    return {
      text: `[ИЗОБРАЖЕНИЕ]\nПодпись: ${image.caption || 'нет'}\nОписание: не получено`,
      derivedText: image.caption || null,
      processingStatus: 'failed',
      processingError: err.message,
      buffer: null,
      mimeType: 'image/jpeg',
    };
  }
}

async function checkDailyImageLimit(channel, chatId) {
  return checkDailyCount(channel, chatId, 'image', config.DAILY_IMAGE_LIMIT);
}

async function incrementDailyImageCount(channel, chatId) {
  return incrementDailyCount(channel, chatId, 'image');
}

async function describeImage(image, channel) {
  const { image_ref, caption, baileys_media_obj } = image;
  let description = 'Описание не получено';
  const fullPrompt = `${VISION_PROMPT}\n\nПодпись клиента: ${caption || 'нет'}`;

  try {
    if (image_ref === 'wa-baileys' && baileys_media_obj) {
      // WhatsApp Baileys — download encrypted image.
      const baileys = require('../services/baileys');
      const buffer = await baileys.downloadMedia(baileys_media_obj, 'image');
      description = await analyzeImageBase64(buffer.toString('base64'), 'image/jpeg', fullPrompt);
    } else if (channel === 'telegram' && image_ref && image_ref.startsWith('tg:')) {
      const fileId = image_ref.replace('tg:', '');
      const { buffer } = await tgClient.downloadFile(fileId);
      description = await analyzeImageBase64(buffer.toString('base64'), 'image/jpeg', fullPrompt);
    } else if (channel === 'instagram' && image_ref) {
      // Wazzup CDN sometimes requires Bearer authentication, so download first.
      const wazzup = require('../services/wazzup');
      const { buffer, mimeType } = await wazzup.downloadContent(image_ref);
      const mt = (mimeType && mimeType.startsWith('image/')) ? mimeType : 'image/jpeg';
      description = await analyzeImageBase64(buffer.toString('base64'), mt, fullPrompt);
    } else if (image_ref && !image_ref.startsWith('tg:') && image_ref !== 'wa-baileys') {
      description = await analyzeImageUrl(image_ref, fullPrompt);
    }
  } catch (err) {
    console.error('[Image] Analyze error:', err.message);
  }

  return description;
}

async function analyzeImages(images, channel, chatId) {
  const blocks = [];

  for (const img of images) {
    const description = await describeImage(img, channel);

    blocks.push(`[ИЗОБРАЖЕНИЕ ${img.index}]\ncaption: ${img.caption || 'нет'}\nописание: ${description}`);
  }

  return `СИСТЕМНЫЙ КОНТЕКСТ: ниже описания изображений от клиента.\n\n${blocks.join('\n\n')}`;
}

module.exports = {
  analyzeImages, describeImage, processImage, downloadImageBuffer, describeImageBuffer,
  checkDailyImageLimit, incrementDailyImageCount,
};

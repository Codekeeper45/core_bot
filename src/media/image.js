'use strict';
const { analyzeImageUrl, analyzeImageBase64 } = require('../services/openrouterMedia');
const { checkDailyCount, incrementDailyCount } = require('../services/mysql');
const tgClient = require('../channels/telegram');
const config = require('../config');

const VISION_PROMPT = `Опиши, что изображено на картинке. Если на изображении есть текст —
извлеки его. Если это документ, таблица или скриншот — кратко передай ключевую информацию
(суммы, даты, числа, названия). Отвечай кратко и по существу, на языке пользователя.`;

async function checkDailyImageLimit(channel, chatId) {
  return checkDailyCount(channel, chatId, 'image', config.DAILY_IMAGE_LIMIT);
}

async function incrementDailyImageCount(channel, chatId) {
  return incrementDailyCount(channel, chatId, 'image');
}

async function analyzeImages(images, channel, chatId) {
  const blocks = [];

  for (const img of images) {
    const { image_ref, caption, index, baileys_media_obj } = img;
    let description = 'Описание не получено';

    const fullPrompt = `${VISION_PROMPT}\n\nПодпись клиента: ${caption || 'нет'}`;

    try {
      if (image_ref === 'wa-baileys' && baileys_media_obj) {
        // WhatsApp Baileys — download encrypted image
        const baileys = require('../services/baileys');
        const buffer = await baileys.downloadMedia(baileys_media_obj, 'image');
        const base64 = buffer.toString('base64');
        description = await analyzeImageBase64(base64, 'image/jpeg', fullPrompt);
      } else if (channel === 'telegram' && image_ref && image_ref.startsWith('tg:')) {
        const fileId = image_ref.replace('tg:', '');
        const { buffer } = await tgClient.downloadFile(fileId);
        const base64 = buffer.toString('base64');
        description = await analyzeImageBase64(base64, 'image/jpeg', fullPrompt);
      } else if (channel === 'instagram' && image_ref) {
        // Instagram via Wazzup — скачиваем сами (Wazzup CDN иногда требует
        // Bearer), кодируем в base64 → vision-моделька не дёргает CDN сама.
        const wazzup = require('../services/wazzup');
        const { buffer, mimeType } = await wazzup.downloadContent(image_ref);
        const base64 = buffer.toString('base64');
        const mt = (mimeType && mimeType.startsWith('image/')) ? mimeType : 'image/jpeg';
        description = await analyzeImageBase64(base64, mt, fullPrompt);
      } else if (image_ref && !image_ref.startsWith('tg:') && image_ref !== 'wa-baileys') {
        const url = image_ref;
        description = await analyzeImageUrl(url, fullPrompt);
      }
    } catch (err) {
      console.error('[Image] Analyze error:', err.message);
    }

    blocks.push(`[ИЗОБРАЖЕНИЕ ${index}]\ncaption: ${caption || 'нет'}\nописание: ${description}`);
  }

  return `СИСТЕМНЫЙ КОНТЕКСТ: ниже описания изображений от клиента.\n\n${blocks.join('\n\n')}`;
}

module.exports = { analyzeImages, checkDailyImageLimit, incrementDailyImageCount };

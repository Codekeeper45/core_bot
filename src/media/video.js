'use strict';
// Обработка видео-подобных входящих: обычное видео, видеокружок (video note),
// гифка/анимация и стикеры. Видео смотрит Gemini (analyzeVideoBase64 — модель
// видит кадры целиком), речь дополнительно транскрибируется Whisper'ом (mp4-контейнер
// он понимает). Гифки обычно немые — их не транскрибируем. Стикеры: статичные
// (webp) идут через vision; анимированные .tgs (lottie-JSON) распарсить нечем —
// честный фолбэк на эмодзи стикера.
const { analyzeVideoBase64, analyzeImageBase64, transcribeAudio } = require('../services/openrouterMedia');
const { checkDailyCount, incrementDailyCount } = require('../services/mysql');
const tgClient = require('../channels/telegram');
const config = require('../config');

const KIND_RU = { video: 'ВИДЕО', video_note: 'ВИДЕОКРУЖОК', animation: 'ГИФКА' };

const VIDEO_PROMPT = `Опиши, что происходит в этом видео: кто/что в кадре, действия, обстановка.
Если в кадре есть текст, вывески, документы, товары или цифры — извлеки их. Если человек что-то
показывает или демонстрирует — опиши что именно. Отвечай кратко и по существу, на языке пользователя.`;

const STICKER_PROMPT = `Это стикер из мессенджера. Опиши кратко: что/кто изображён и какую эмоцию
или реакцию передаёт стикер. Одно-два предложения, на языке пользователя.`;

async function checkDailyVideoLimit(channel, chatId) {
  return checkDailyCount(channel, chatId, 'video', config.DAILY_VIDEO_LIMIT);
}

async function incrementDailyVideoCount(channel, chatId) {
  return incrementDailyCount(channel, chatId, 'video');
}

// Скачивание видео/стикера по каналу-источнику (та же логика, что у voice/document).
async function downloadVideoBuffer(normalized) {
  const { channel, video_source_url, video_file_id, baileys_media_obj, baileys_media_type } = normalized;
  if (channel === 'telegram' && video_file_id) {
    const { buffer } = await tgClient.downloadFile(video_file_id);
    return buffer;
  }
  if (baileys_media_obj) {
    const baileys = require('../services/baileys');
    return baileys.downloadMedia(baileys_media_obj, baileys_media_type || 'video');
  }
  if (channel === 'instagram' && video_source_url) {
    const wazzup = require('../services/wazzup');
    const { buffer } = await wazzup.downloadContent(video_source_url);
    return buffer;
  }
  if (video_source_url) {
    const res = await fetch(video_source_url);
    if (!res.ok) throw new Error(`Download failed: ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }
  throw new Error('No video source available');
}

// Видео / кружок / гифка → текстовый блок для агента:
// [ВИДЕО] caption / описание (Gemini) / транскрипция речи (Whisper, кроме гифок).
async function processVideo(normalized) {
  const { channel, chat_id, message_type, video_mime_type } = normalized;
  const kind = KIND_RU[message_type] || 'ВИДЕО';

  const limitExceeded = await checkDailyVideoLimit(channel, chat_id);
  if (limitExceeded) {
    return { error: `Сегодня можно отправить не больше ${config.DAILY_VIDEO_LIMIT} видео. Попробуйте продолжить завтра.` };
  }

  let buffer;
  try {
    buffer = await downloadVideoBuffer(normalized);
  } catch (err) {
    console.error('[Video] Download error:', err.message);
    return { error: 'Не удалось скачать видео. Попробуйте отправить ещё раз.' };
  }

  const maxBytes = config.VIDEO_MAX_MB * 1024 * 1024;
  if (buffer.length > maxBytes) {
    return { error: `Видео слишком большое для обработки (максимум ${config.VIDEO_MAX_MB} МБ). Отправьте покороче или сожмите.` };
  }

  await incrementDailyVideoCount(channel, chat_id);

  const mime = (video_mime_type || 'video/mp4').split(';')[0].trim();
  const base64 = buffer.toString('base64');

  let description = null;
  try {
    description = await analyzeVideoBase64(base64, mime, `${VIDEO_PROMPT}\n\nПодпись клиента: ${normalized.message || 'нет'}`);
  } catch (err) {
    console.error('[Video] Analyze error:', err.message);
  }

  // Речь из видео — отдельной дорожкой через Whisper. Гифки немые — пропускаем.
  let transcript = null;
  if (message_type !== 'animation') {
    try {
      transcript = (await transcribeAudio(buffer, mime)) || null;
    } catch (err) {
      console.error('[Video] Transcribe error:', err.message);
    }
  }

  if (!description && !transcript) {
    return { error: 'Не удалось разобрать видео. Попробуйте отправить ещё раз или опишите словами.' };
  }

  const lines = [`[${kind}]`];
  if (normalized.message) lines.push(`подпись: ${normalized.message}`);
  if (description) lines.push(`описание: ${description}`);
  if (transcript) lines.push(`транскрипция речи: ${transcript}`);
  return { text: `СИСТЕМНЫЙ КОНТЕКСТ: клиент прислал ${kind.toLowerCase()}.\n\n${lines.join('\n')}` };
}

// Стикер → короткое описание. Статичный/анимированный webp и видео-стикер webm
// понимает Gemini (webp через vision, webm через video); .tgs (lottie) — фолбэк
// на эмодзи стикера.
async function processSticker(normalized) {
  const { sticker_emoji, sticker_format } = normalized;
  const emojiNote = sticker_emoji ? ` (эмодзи: ${sticker_emoji})` : '';

  if (sticker_format === 'tgs') {
    return { text: `[СТИКЕР${emojiNote}] Анимированный стикер — содержимое разобрать нельзя, ориентируйся на эмодзи.` };
  }

  let buffer;
  try {
    buffer = await downloadVideoBuffer(normalized);
  } catch (err) {
    console.error('[Sticker] Download error:', err.message);
    return { text: `[СТИКЕР${emojiNote}] Скачать стикер не удалось — ориентируйся на эмодзи.` };
  }

  const base64 = buffer.toString('base64');
  try {
    let description;
    if (sticker_format === 'webm') {
      description = await analyzeVideoBase64(base64, 'video/webm', STICKER_PROMPT);
    } else {
      description = await analyzeImageBase64(base64, 'image/webp', STICKER_PROMPT);
    }
    return { text: `[СТИКЕР${emojiNote}] ${description}` };
  } catch (err) {
    console.error('[Sticker] Analyze error:', err.message);
    return { text: `[СТИКЕР${emojiNote}] Разобрать изображение стикера не удалось — ориентируйся на эмодзи.` };
  }
}

module.exports = { processVideo, processSticker, downloadVideoBuffer, checkDailyVideoLimit };

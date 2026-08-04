'use strict';
const OpenAI = require('openai');
const config = require('../config');

// Цепочки моделей: primary → fallback. Пустые/дубли отбрасываются.
function modelChain(primary, fallback) {
  return [primary, fallback].filter((m, i, a) => m && a.indexOf(m) === i);
}

let client;
function getClient() {
  if (!client) {
    client = new OpenAI({
      baseURL: 'https://openrouter.ai/api/v1',
      apiKey: config.OPENROUTER_API_KEY,
    });
  }
  return client;
}

function detectAudioFormat(mimeType) {
  if (!mimeType) return 'ogg';
  if (mimeType.includes('webm')) return 'webm';
  if (mimeType.includes('ogg')) return 'ogg';
  if (mimeType.includes('mp3')) return 'mp3';
  // ВАЖНО: video/mp4 и audio/mp4 → 'mp4' (Whisper понимает mp4-контейнер и
  // берёт из него аудиодорожку — так транскрибируются видео и кружки).
  if (mimeType.includes('mp4') || mimeType.includes('m4a') || mimeType.includes('quicktime')) return 'mp4';
  if (mimeType.includes('mpeg')) return 'mp3';
  if (mimeType.includes('wav')) return 'wav';
  if (mimeType.includes('aac')) return 'aac';
  if (mimeType.includes('flac')) return 'flac';
  return 'ogg';
}

async function transcribeWithModel(model, base64, format) {
  const response = await fetch('https://openrouter.ai/api/v1/audio/transcriptions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${config.OPENROUTER_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      input_audio: { data: base64, format },
    }),
  });

  const result = await response.json();
  if (!response.ok) throw new Error(`STT error ${response.status}: ${JSON.stringify(result)}`);
  return (result.text || '').trim();
}

// Мультимодальные STT-фолбэк-модели (напр. nvidia/nemotron-3-nano-omni-*) НЕ ходят
// через /audio/transcriptions — голосовой принимается как audio_url в chat.completions
// (OpenRouter-совместимый путь). Нужно протестировать поддержку форматов на модели.
function isChatAudioModel(model) {
  return /nemotron|omni/i.test(model || '');
}

async function transcribeWithChatAudio(model, base64, format) {
  const mime = { ogg: 'audio/ogg', webm: 'audio/webm', mp3: 'audio/mpeg', mp4: 'audio/mp4', wav: 'audio/wav', aac: 'audio/aac', flac: 'audio/flac' }[format] || 'audio/ogg';
  const dataUrl = `data:${mime};base64,${base64}`;
  const response = await getClient().chat.completions.create({
    model,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'audio_url', audio_url: { url: dataUrl } },
          { type: 'text', text: 'Распознай речь из этого аудио и верни ТОЛЬКО расшифрованный текст.' },
        ],
      },
    ],
    max_tokens: 1024,
  });
  const text = (response.choices?.[0]?.message?.content || '').trim();
  if (!text) throw new Error(`STT (chat-audio) empty response for ${model}`);
  return text;
}

async function transcribeAudio(buffer, mimeType = 'audio/ogg') {
  const base64 = buffer.toString('base64');
  const format = detectAudioFormat(mimeType);
  const chain = modelChain(config.STT_MODEL, config.STT_FALLBACK_MODEL);

  let lastErr;
  for (const model of chain) {
    try {
      return await transcribeWithModel(model, base64, format);
    } catch (err) {
      lastErr = err;
      console.error(`[STT] модель ${model} не сработала (transcriptions): ${err.message}`);
    }
    // Для omni-моделей пробуем chat-audio путь (transcriptions им не подходит).
    if (isChatAudioModel(model)) {
      try {
        return await transcribeWithChatAudio(model, base64, format);
      } catch (err) {
        lastErr = err;
        console.error(`[STT] модель ${model} не сработала (chat-audio): ${err.message}`);
      }
    }
  }
  throw lastErr || new Error('STT: не задана ни одна модель');
}

async function analyzeImageBase64(base64, mimeType = 'image/jpeg', prompt) {
  const dataUrl = `data:${mimeType};base64,${base64}`;
  const messages = [
    {
      role: 'user',
      content: [
        { type: 'text', text: prompt },
        { type: 'image_url', image_url: { url: dataUrl } },
      ],
    },
  ];
  const chain = modelChain(config.VISION_MODEL, config.VISION_FALLBACK_MODEL);

  let lastErr;
  for (const model of chain) {
    try {
      const response = await getClient().chat.completions.create({ model, messages });
      return (response.choices[0]?.message?.content || '').trim();
    } catch (err) {
      lastErr = err;
      console.error(`[Vision] модель ${model} не сработала: ${err.message}`);
    }
  }
  throw lastErr || new Error('Vision: не задана ни одна модель');
}

async function analyzeImageUrl(imageUrl, prompt) {
  const res = await fetch(imageUrl);
  if (!res.ok) throw new Error(`Image download failed: ${res.status}`);
  const buffer = Buffer.from(await res.arrayBuffer());
  const mimeType = (res.headers.get('content-type') || 'image/jpeg').split(';')[0].trim();
  return analyzeImageBase64(buffer.toString('base64'), mimeType, prompt);
}

// Видео (обычное, кружок, гифка) — Gemini смотрит его целиком через OpenRouter
// content type video_url с base64 data-URL (OpenRouter маршрутизирует в провайдера
// с поддержкой видео; форматы mp4/mpeg/mov/webm).
async function analyzeVideoBase64(base64, mimeType = 'video/mp4', prompt) {
  const dataUrl = `data:${mimeType};base64,${base64}`;
  const messages = [
    {
      role: 'user',
      content: [
        { type: 'text', text: prompt },
        { type: 'video_url', video_url: { url: dataUrl } },
      ],
    },
  ];
  const chain = modelChain(config.VIDEO_MODEL, config.VIDEO_FALLBACK_MODEL);

  let lastErr;
  for (const model of chain) {
    try {
      const response = await getClient().chat.completions.create({ model, messages });
      return (response.choices[0]?.message?.content || '').trim();
    } catch (err) {
      lastErr = err;
      console.error(`[Video] модель ${model} не сработала: ${err.message}`);
    }
  }
  throw lastErr || new Error('Video: не задана ни одна модель');
}

module.exports = { transcribeAudio, analyzeImageUrl, analyzeImageBase64, analyzeVideoBase64 };

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
  if (mimeType.includes('ogg')) return 'ogg';
  if (mimeType.includes('mp3') || mimeType.includes('mpeg')) return 'mp3';
  if (mimeType.includes('wav')) return 'wav';
  if (mimeType.includes('mp4') || mimeType.includes('m4a')) return 'mp4';
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
      console.error(`[STT] модель ${model} не сработала: ${err.message}`);
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

module.exports = { transcribeAudio, analyzeImageUrl, analyzeImageBase64 };

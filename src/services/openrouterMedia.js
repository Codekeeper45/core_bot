'use strict';
const OpenAI = require('openai');
const config = require('../config');

const MULTIMODAL_MODEL = 'google/gemini-3.1-flash-lite-preview';

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

async function transcribeAudio(buffer, mimeType = 'audio/ogg') {
  const base64 = buffer.toString('base64');
  const format = detectAudioFormat(mimeType);

  const response = await fetch('https://openrouter.ai/api/v1/audio/transcriptions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${config.OPENROUTER_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'google/chirp-3',
      input_audio: { data: base64, format },
    }),
  });

  const result = await response.json();
  if (!response.ok) throw new Error(`STT error ${response.status}: ${JSON.stringify(result)}`);
  return (result.text || '').trim();
}

async function analyzeImageBase64(base64, mimeType = 'image/jpeg', prompt) {
  const dataUrl = `data:${mimeType};base64,${base64}`;

  const response = await getClient().chat.completions.create({
    model: MULTIMODAL_MODEL,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          { type: 'image_url', image_url: { url: dataUrl } },
        ],
      },
    ],
  });

  return (response.choices[0]?.message?.content || '').trim();
}

async function analyzeImageUrl(imageUrl, prompt) {
  const res = await fetch(imageUrl);
  if (!res.ok) throw new Error(`Image download failed: ${res.status}`);
  const buffer = Buffer.from(await res.arrayBuffer());
  const mimeType = (res.headers.get('content-type') || 'image/jpeg').split(';')[0].trim();
  return analyzeImageBase64(buffer.toString('base64'), mimeType, prompt);
}

module.exports = { transcribeAudio, analyzeImageUrl, analyzeImageBase64 };

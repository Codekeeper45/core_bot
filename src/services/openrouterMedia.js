'use strict';
const OpenAI = require('openai');
const config = require('../config');
const {
  getGoogleGeminiClient, getGoogleGeminiPool, hasGoogleGeminiKeys,
} = require('./googleGeminiPool');
const { _internals: circuitInternals } = require('./llmCircuitBreaker');

const _mediaModelCooldowns = new Map();

function isMediaModelOnCooldown(model) {
  const expires = _mediaModelCooldowns.get(model);
  if (!expires) return false;
  if (Date.now() > expires) {
    _mediaModelCooldowns.delete(model);
    return false;
  }
  return true;
}

function markMediaModelCooldown(model, durationMs = 5 * 60 * 1000) {
  _mediaModelCooldowns.set(model, Date.now() + durationMs);
}

function cooldownFor(error) {
  return circuitInternals.classifyCircuitError(error).cooldownMs;
}

function isFreeOpenRouterModel(model) {
  return model === 'openrouter/free' || /:free$/i.test(String(model || ''));
}

// Цепочки моделей: primary → fallback. Пустые/дубли отбрасываются, сбойные на кулдауне пропускаются.
function modelChain(primary, fallback) {
  const chain = [primary, fallback].filter((m, i, a) => m && a.indexOf(m) === i);
  return chain.filter((m) => !isMediaModelOnCooldown(m));
}

function freeModelChain(...models) {
  return [...new Set(models.filter(isFreeOpenRouterModel))]
    .filter((model) => !isMediaModelOnCooldown(model));
}

let client;
function getClient() {
  if (!client) {
    client = new OpenAI({
      baseURL: 'https://openrouter.ai/api/v1',
      apiKey: config.OPENROUTER_API_KEY,
      maxRetries: 0,
      timeout: config.LLM_PROVIDER_TIMEOUT_MS,
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
  const response = await getClient().chat.completions.create({
    model,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'input_audio', input_audio: { data: base64, format } },
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

async function transcribeWithGoogle(base64, format) {
  const response = await getGoogleGeminiClient().chat.completions.create({
    model: config.GOOGLE_GEMINI_MODEL,
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: 'Распознай речь из этого аудио и верни ТОЛЬКО расшифрованный текст.' },
        { type: 'input_audio', input_audio: { data: base64, format } },
      ],
    }],
    max_tokens: 1024,
  });
  const text = (response.choices?.[0]?.message?.content || '').trim();
  if (!text) throw new Error('Google STT returned an empty response');
  return text;
}

async function transcribeAudio(buffer, mimeType = 'audio/ogg') {
  const base64 = buffer.toString('base64');
  const format = detectAudioFormat(mimeType);
  const chain = freeModelChain(
    config.STT_MODEL,
    config.STT_FALLBACK_MODEL,
    config.OPENROUTER_FALLBACK_MODEL
  );

  let lastErr;
  if (hasGoogleGeminiKeys()) {
    try {
      return await transcribeWithGoogle(base64, format);
    } catch (err) {
      lastErr = err;
      console.error(`[STT] Google Gemini не сработал: ${err.message}`);
    }
  }
  for (const model of chain) {
    if (isChatAudioModel(model) || model === 'openrouter/free') {
      try {
        return await transcribeWithChatAudio(model, base64, format);
      } catch (err) {
        lastErr = err;
        markMediaModelCooldown(model, cooldownFor(err));
        console.error(`[STT] модель ${model} не сработала (chat-audio): ${err.message}`);
      }
      continue;
    }
    try {
      return await transcribeWithModel(model, base64, format);
    } catch (err) {
      lastErr = err;
      markMediaModelCooldown(model, cooldownFor(err));
      console.error(`[STT] модель ${model} не сработала (transcriptions): ${err.message}`);
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
  const chain = freeModelChain(
    config.VISION_MODEL,
    config.VISION_FALLBACK_MODEL,
    config.OPENROUTER_FALLBACK_MODEL
  );

  let lastErr;
  if (hasGoogleGeminiKeys()) {
    try {
      const response = await getGoogleGeminiClient().chat.completions.create({
        model: config.GOOGLE_GEMINI_MODEL,
        messages,
      });
      const text = (response.choices?.[0]?.message?.content || '').trim();
      if (!text) throw new Error('Google Vision returned an empty response');
      return text;
    } catch (err) {
      lastErr = err;
      console.error(`[Vision] Google Gemini не сработал: ${err.message}`);
    }
  }
  for (const model of chain) {
    try {
      const response = await getClient().chat.completions.create({ model, messages });
      return (response.choices[0]?.message?.content || '').trim();
    } catch (err) {
      lastErr = err;
      markMediaModelCooldown(model, cooldownFor(err));
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

function interactionText(json) {
  if (json && typeof json.output_text === 'string') return json.output_text.trim();
  const parts = [];
  for (const step of (json && Array.isArray(json.steps) ? json.steps : [])) {
    if (step.type !== 'model_output' || !Array.isArray(step.content)) continue;
    for (const item of step.content) {
      if (item && item.type === 'text' && item.text) parts.push(String(item.text));
    }
  }
  return parts.join('\n').trim();
}

async function analyzeVideoWithGoogle(base64, mimeType, prompt) {
  return getGoogleGeminiPool().execute(async (_client, key) => {
    const response = await fetch(`${config.GOOGLE_GEMINI_NATIVE_BASE_URL}/interactions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': key,
      },
      body: JSON.stringify({
        model: config.GOOGLE_GEMINI_MODEL,
        input: [
          { type: 'video', data: base64, mime_type: mimeType },
          { type: 'text', text: prompt },
        ],
      }),
      signal: AbortSignal.timeout(config.GOOGLE_GEMINI_TIMEOUT_MS),
    });
    const json = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(`Google Video ${response.status}: ${json.error?.message || 'request failed'}`);
      error.status = response.status;
      error.headers = response.headers;
      throw error;
    }
    const text = interactionText(json);
    if (!text) throw new Error('Google Video returned an empty response');
    return text;
  });
}

// Видео (обычное, кружок, гифка) сначала смотрит прямой бесплатный Gemini.
// OpenRouter остаётся резервом только вне FREE_AI_ONLY: даже free-router требует
// положительный баланс аккаунта для video input.
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
  const chain = config.FREE_AI_ONLY ? [] : freeModelChain(
    config.VIDEO_MODEL, config.VIDEO_FALLBACK_MODEL, config.OPENROUTER_FALLBACK_MODEL
  );

  let lastErr;
  if (hasGoogleGeminiKeys()) {
    try {
      return await analyzeVideoWithGoogle(base64, mimeType, prompt);
    } catch (err) {
      lastErr = err;
      console.error(`[Video] Google Gemini не сработал: ${err.message}`);
    }
  }
  for (const model of chain) {
    try {
      const response = await getClient().chat.completions.create({ model, messages });
      return (response.choices[0]?.message?.content || '').trim();
    } catch (err) {
      lastErr = err;
      markMediaModelCooldown(model, cooldownFor(err));
      console.error(`[Video] модель ${model} не сработала: ${err.message}`);
    }
  }
  throw lastErr || new Error('Video: не задана ни одна модель');
}

module.exports = {
  transcribeAudio, analyzeImageUrl, analyzeImageBase64, analyzeVideoBase64,
  _internals: {
    isMediaModelOnCooldown, markMediaModelCooldown, isFreeOpenRouterModel,
    modelChain, freeModelChain, detectAudioFormat, isChatAudioModel, interactionText,
  },
};

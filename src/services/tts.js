'use strict';
// Озвучка ответов (TTS). Источник 1 — Google Gemini (несколько ключей с КРУГОВОЙ ротацией
// по запросам, чтобы распределять квоту, + перебор оставшихся при 429). Источник 2 (fallback) —
// OpenRouter /audio/speech (тот же Gemini TTS через прокси), если ни один Google-ключ не ответил.
// Аудио приводится к OGG/Opus через ffmpeg-static; иначе отдаём как есть (WAV/MP3).
const { spawn } = require('node:child_process');
const config = require('../config');

// Указатель круговой ротации Google-ключей: каждый запрос НАЧИНАЕТ со следующего ключа,
// так нагрузка распределяется равномерно (а не «первый ключ ест всё, пока не упрётся»).
let rrIndex = 0;

// Google-ключи в порядке ротации для ТЕКУЩЕГО запроса (старт со сдвигом rrIndex).
function googleKeysRotated() {
  const list = config.GOOGLE_GENAI_API_KEYS.length
    ? config.GOOGLE_GENAI_API_KEYS
    : (config.GOOGLE_GENAI_API_KEY ? [config.GOOGLE_GENAI_API_KEY] : []);
  if (list.length <= 1) return list;
  const start = rrIndex % list.length;
  rrIndex = (rrIndex + 1) % list.length; // сдвиг на следующий запрос
  return [...list.slice(start), ...list.slice(0, start)];
}

// PCM16 mono → WAV (ручной 44-байтовый заголовок, без зависимостей).
function pcmToWav(pcm, sampleRate = 24000) {
  const numChannels = 1;
  const bytesPerSample = 2;
  const byteRate = sampleRate * numChannels * bytesPerSample;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);            // PCM
  header.writeUInt16LE(numChannels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(numChannels * bytesPerSample, 32);
  header.writeUInt16LE(16, 34);           // bits per sample
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

// Любое аудио (WAV/MP3/...) → OGG/Opus через ffmpeg-static (вход автодетектится).
// null, если ffmpeg недоступен/упал (→ отдаём исходный буфер).
function toOgg(inputBuffer) {
  return new Promise((resolve) => {
    let ffmpegPath;
    try { ffmpegPath = require('ffmpeg-static'); } catch (_) { ffmpegPath = 'ffmpeg'; }
    if (!ffmpegPath) return resolve(null);
    let proc;
    try {
      proc = spawn(ffmpegPath, ['-i', 'pipe:0', '-c:a', 'libopus', '-b:a', '24k', '-f', 'ogg', 'pipe:1'],
        { stdio: ['pipe', 'pipe', 'ignore'] });
    } catch (_) { return resolve(null); }
    const out = [];
    proc.stdout.on('data', (d) => out.push(d));
    proc.on('error', () => resolve(null));
    proc.on('close', (code) => resolve(code === 0 && out.length ? Buffer.concat(out) : null));
    proc.stdin.on('error', () => {});
    proc.stdin.end(inputBuffer);
  });
}

// Источник 1: Google Gemini напрямую. Перебирает ротированные ключи, на 429/403 → следующий.
async function tryGoogle(text, voiceName) {
  const k = googleKeysRotated();
  if (!k.length) return { ok: false, error: 'нет Google-ключей' };
  const body = {
    contents: [{ parts: [{ text }] }],
    generationConfig: {
      responseModalities: ['AUDIO'],
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName } } },
    },
  };
  let lastErr = 'unknown';
  for (const key of k) {
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${config.TTS_MODEL}:generateContent?key=${key}`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30000),
      });
      if (res.status === 429 || res.status === 403) { lastErr = `quota ${res.status}`; continue; }
      if (!res.ok) { lastErr = `Gemini ${res.status}`; continue; }
      const data = await res.json();
      const b64 = data?.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
      if (!b64) { lastErr = 'нет аудио в ответе'; continue; }
      return { ok: true, buffer: pcmToWav(Buffer.from(b64, 'base64'), 24000) }; // WAV (вход для toOgg)
    } catch (err) {
      lastErr = err.message;
    }
  }
  return { ok: false, error: lastErr };
}

// Источник 2 (fallback): OpenRouter /audio/speech (OpenAI-совместимый, сырые байты mp3).
async function tryOpenRouter(text, voiceName) {
  if (!config.OPENROUTER_API_KEY) return { ok: false, error: 'нет OPENROUTER_API_KEY' };
  try {
    const res = await fetch('https://openrouter.ai/api/v1/audio/speech', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: config.OPENROUTER_TTS_MODEL,
        input: text,
        voice: config.OPENROUTER_TTS_VOICE || voiceName,
        response_format: 'mp3',
      }),
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) return { ok: false, error: `OpenRouter TTS ${res.status}` };
    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length) return { ok: false, error: 'OpenRouter: пустой ответ' };
    return { ok: true, buffer: buf }; // MP3 (вход для toOgg)
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// Синтез речи. Возвращает { ok, media:{kind:'voice', buffer, format} } или { ok:false, error }.
async function synthesizeSpeech(text, voice) {
  if (!text || !String(text).trim()) return { ok: false, error: 'Пустой текст.' };
  const clean = String(text).slice(0, 2000);
  const voiceName = voice || config.TTS_VOICE;

  const hasGoogle = config.GOOGLE_GENAI_API_KEYS.length || config.GOOGLE_GENAI_API_KEY;
  if (!hasGoogle && !config.OPENROUTER_API_KEY) {
    return { ok: false, error: 'TTS не настроен (нет GOOGLE_GENAI_API_KEY и OPENROUTER_API_KEY).' };
  }

  // 1) Google (с ротацией ключей), 2) OpenRouter fallback.
  let r = hasGoogle ? await tryGoogle(clean, voiceName) : { ok: false, error: 'нет Google-ключей' };
  let source = 'google';
  if (!r.ok) {
    const fb = await tryOpenRouter(clean, voiceName);
    if (fb.ok) { r = fb; source = 'openrouter'; }
    else return { ok: false, error: `все TTS недоступны (google: ${r.error}; openrouter: ${fb.error})` };
  }

  const ogg = await toOgg(r.buffer);
  return {
    ok: true,
    source,
    media: { kind: 'voice', buffer: ogg || r.buffer, format: ogg ? 'ogg' : (source === 'openrouter' ? 'mp3' : 'wav') },
  };
}

module.exports = { synthesizeSpeech, _internals: { pcmToWav, toOgg, googleKeysRotated } };

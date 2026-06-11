'use strict';
// Озвучка ответов (TTS) через Google Gemini REST. PCM 24kHz → OGG/Opus (ffmpeg-static),
// fallback — WAV без зависимостей. Ключи ротируются при 429 (как в референсе Bot_opekyn).
const { spawn } = require('node:child_process');
const config = require('../config');

function keys() {
  const list = config.GOOGLE_GENAI_API_KEYS.length
    ? config.GOOGLE_GENAI_API_KEYS
    : (config.GOOGLE_GENAI_API_KEY ? [config.GOOGLE_GENAI_API_KEY] : []);
  return list;
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

// WAV → OGG/Opus через ffmpeg-static. null, если ffmpeg недоступен/упал (→ fallback WAV).
function wavToOgg(wav) {
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
    proc.stdin.end(wav);
  });
}

// Синтез речи. Возвращает { ok, media:{kind:'voice', buffer} } или { ok:false, error }.
async function synthesizeSpeech(text, voice) {
  const k = keys();
  if (!k.length) return { ok: false, error: 'TTS не настроен (нет GOOGLE_GENAI_API_KEY).' };
  if (!text || !String(text).trim()) return { ok: false, error: 'Пустой текст.' };

  const voiceName = voice || config.TTS_VOICE;
  const body = {
    contents: [{ parts: [{ text: String(text).slice(0, 2000) }] }],
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
      if (res.status === 429 || res.status === 403) { lastErr = `quota ${res.status}`; continue; } // следующий ключ
      if (!res.ok) { lastErr = `Gemini ${res.status}`; continue; }
      const data = await res.json();
      const b64 = data?.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
      if (!b64) { lastErr = 'нет аудио в ответе'; continue; }
      const pcm = Buffer.from(b64, 'base64');
      const wav = pcmToWav(pcm, 24000);
      const ogg = await wavToOgg(wav);
      // OGG/Opus → нормальное голосовое; иначе WAV (тоже проиграется как аудио).
      return { ok: true, media: { kind: 'voice', buffer: ogg || wav, format: ogg ? 'ogg' : 'wav' } };
    } catch (err) {
      lastErr = err.message;
    }
  }
  return { ok: false, error: lastErr };
}

module.exports = { synthesizeSpeech, _internals: { pcmToWav, wavToOgg } };

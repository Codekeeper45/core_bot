'use strict';
// Озвучка ответов (TTS). Источник 1 — Google Gemini (несколько ключей с КРУГОВОЙ ротацией
// по запросам, чтобы распределять квоту, + перебор оставшихся при 429). Источник 2 (fallback) —
// OpenRouter /audio/speech (тот же Gemini TTS через прокси), если ни один Google-ключ не ответил.
// Аудио приводится к OGG/Opus через ffmpeg-static; иначе отдаём как есть (WAV/MP3).
const { spawn } = require('node:child_process');
const config = require('../config');

// Полный каталог голосов Gemini (30). Используется для валидации, подсказки характера в
// TTS-промпте и для list_voices (агент выбирает голос под ситуацию). g — пол (m/f).
const VOICE_PROFILES = {
  Achernar: { tone: 'Soft', g: 'f', personality: 'мягкий, нежный — утешение и ласка' },
  Achird: { tone: 'Friendly', g: 'f', personality: 'дружелюбный, тёплый — универсальный собеседник' },
  Algenib: { tone: 'Gravelly', g: 'm', personality: 'хриплый, харизматичный — серьёзные темы' },
  Algieba: { tone: 'Smooth', g: 'm', personality: 'плавный, спокойный — объяснения' },
  Alnilam: { tone: 'Firm', g: 'm', personality: 'твёрдый, уверенный — мотивация, инструкции' },
  Aoede: { tone: 'Breezy', g: 'f', personality: 'лёгкий, воздушный — повседневные беседы' },
  Autonoe: { tone: 'Bright', g: 'f', personality: 'яркий, энергичный — радостные новости' },
  Callirrhoe: { tone: 'Easy-going', g: 'f', personality: 'непринуждённый, расслабленный — дружеский тон' },
  Charon: { tone: 'Informative', g: 'm', personality: 'информативный, взвешенный — факты и новости' },
  Despina: { tone: 'Smooth', g: 'f', personality: 'гладкий, ровный — универсальный' },
  Enceladus: { tone: 'Breathy', g: 'm', personality: 'дыхательный, интимный — тихие моменты' },
  Erinome: { tone: 'Clear', g: 'f', personality: 'чёткий, ясный — объяснения и обучение' },
  Fenrir: { tone: 'Excitable', g: 'm', personality: 'возбудимый, эмоциональный — шутки и сюрпризы' },
  Gacrux: { tone: 'Mature', g: 'm', personality: 'зрелый, мудрый — советы и размышления' },
  Iapetus: { tone: 'Clear', g: 'm', personality: 'чёткий, глубокий — деловые разговоры' },
  Kore: { tone: 'Firm', g: 'f', personality: 'твёрдый, сбалансированный — хороший дефолт' },
  Laomedeia: { tone: 'Upbeat', g: 'f', personality: 'жизнерадостный, бодрый — утренние приветствия' },
  Leda: { tone: 'Youthful', g: 'f', personality: 'молодой, игривый, энергичный (дефолт)' },
  Orus: { tone: 'Firm', g: 'm', personality: 'твёрдый, уверенный — мотивация' },
  Puck: { tone: 'Upbeat', g: 'm', personality: 'весёлый, оживлённый — шутки' },
  Pulcherrima: { tone: 'Forward', g: 'f', personality: 'напористый, прямой — важные напоминания' },
  Rasalgethi: { tone: 'Informative', g: 'm', personality: 'информативный, нейтральный — новости' },
  Sadachbia: { tone: 'Lively', g: 'm', personality: 'живой, динамичный — активные обсуждения' },
  Sadaltager: { tone: 'Knowledgeable', g: 'm', personality: 'знающий, экспертный — обучение' },
  Schedar: { tone: 'Even', g: 'f', personality: 'ровный, стабильный — долгие беседы' },
  Sulafat: { tone: 'Warm', g: 'f', personality: 'тёплый, уютный — поддержка и забота' },
  Umbriel: { tone: 'Easy-going', g: 'm', personality: 'непринуждённый, мягкий — вечерние разговоры' },
  Vindemiatrix: { tone: 'Gentle', g: 'f', personality: 'нежный, ласковый — утешение' },
  Zephyr: { tone: 'Bright', g: 'm', personality: 'современный, яркий — молодёжный тон' },
  Zubenelgenubi: { tone: 'Casual', g: 'm', personality: 'неформальный, расслабленный — для своих' },
};
const DEFAULT_VOICE_TONE = 'нейтральный';

// Список голосов для инструмента выбора (агент видит описания и подбирает под ситуацию).
function listVoices() {
  return Object.entries(VOICE_PROFILES).map(([name, p]) => ({
    name, tone: p.tone, gender: p.g === 'f' ? 'жен' : 'муж', description: p.personality,
  }));
}

function validateVoiceName(name) {
  const n = String(name || '').trim();
  return n || config.TTS_VOICE;
}

// Удалить аудио-теги [excited] и т.п. (для fallback-текста и OpenRouter, где обёртки нет).
function stripAudioTags(text) {
  return String(text || '')
    .replace(/\s*\[[^\]]+\]\s*/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

// Структурированный TTS-промпт (как в референсе): профиль голоса + «режиссёрские заметки»
// с КЛЮЧЕВОЙ инструкцией не зачитывать теги вслух, а трактовать как управление интонацией.
function buildTtsPrompt(text, voiceName) {
  const p = VOICE_PROFILES[voiceName];
  return [
    `# ГОЛОС: ${voiceName}`,
    `Характер: ${p ? `${p.tone}, ${p.personality}` : DEFAULT_VOICE_TONE}.`,
    `Ты — голос делового AI-ассистента. Говоришь по-русски, живо и естественно.`,
    '',
    '## РЕЖИССЁРСКИЕ ЗАМЕТКИ',
    '- Аудио-теги в квадратных скобках ([excited], [warmly], [sighs] и т.п.) и стиль-инструкции',
    '  в начале — это УПРАВЛЕНИЕ ИНТОНАЦИЕЙ. НЕ зачитывай их вслух, только меняй тон.',
    '- Адаптируй интонацию к смыслу. Сохрани текст дословно. Верни только произносимую речь.',
    '',
    '### ТЕКСТ',
    text,
  ].join('\n');
}

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
    contents: [{ parts: [{ text: buildTtsPrompt(text, voiceName) }] }],
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
        // У /audio/speech нет «режиссёрской» обёртки — теги могут прочитаться буквально,
        // поэтому для fallback убираем их (интонация будет нейтральной, но без мусора).
        input: stripAudioTags(text),
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
  const voiceName = validateVoiceName(voice);

  const hasGoogle = config.GOOGLE_GENAI_API_KEYS.length || config.GOOGLE_GENAI_API_KEY;
  if (!hasGoogle && !config.OPENROUTER_API_KEY) {
    return { ok: false, error: 'TTS не настроен (нет GOOGLE_GENAI_API_KEY и OPENROUTER_API_KEY).' };
  }

  // 1) Google (с ротацией ключей), 2) OpenRouter fallback.
  let r = hasGoogle ? await tryGoogle(clean, voiceName) : { ok: false, error: 'нет Google-ключей' };
  let source = 'google';
  if (!r.ok) {
    if (config.FREE_AI_ONLY) {
      return { ok: false, error: `Google TTS недоступен (${r.error}); платный fallback отключён.` };
    }
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

module.exports = {
  synthesizeSpeech,
  VOICE_PROFILES,
  listVoices,
  _internals: { pcmToWav, toOgg, googleKeysRotated, buildTtsPrompt, stripAudioTags, validateVoiceName },
};

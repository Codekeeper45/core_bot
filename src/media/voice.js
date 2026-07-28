'use strict';
const { transcribeAudio } = require('../services/openrouterMedia');
const tgClient = require('../channels/telegram');

const FALLBACK_VOICE = 'Клиент отправил голосовое сообщение, но распознать его не удалось. Вежливо попроси повторить голосом или написать текстом.';

async function downloadVoice(normalized) {
  const { channel, voice_source_url, voice_file_id, voice_mime_type, baileys_media_obj } = normalized;
  let buffer = null;
  let mimeType = voice_mime_type || 'audio/ogg';

  if (channel === 'telegram') {
    const { buffer: buf } = await tgClient.downloadFile(voice_file_id);
    buffer = buf;
  } else if (baileys_media_obj) {
    // WhatsApp via Baileys — download encrypted media.
    const baileys = require('../services/baileys');
    buffer = await baileys.downloadMedia(baileys_media_obj, 'audio');
    mimeType = baileys_media_obj.mimetype || 'audio/ogg; codecs=opus';
  } else if (channel === 'instagram' && voice_source_url) {
    const wazzup = require('../services/wazzup');
    const dl = await wazzup.downloadContent(voice_source_url);
    buffer = dl.buffer;
    if (dl.mimeType && dl.mimeType !== 'application/octet-stream') mimeType = dl.mimeType;
  } else if (voice_source_url) {
    const res = await fetch(voice_source_url);
    if (!res.ok) throw new Error(`Download failed: ${res.status}`);
    buffer = Buffer.from(await res.arrayBuffer());
  } else {
    throw new Error('No media source available for voice');
  }

  if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw new Error('Voice download is empty');
  return { buffer, mimeType };
}

async function transcribeVoiceBuffer(buffer, mimeType = 'audio/ogg', caption = '') {
  let transcript = '';
  try {
    transcript = await transcribeAudio(buffer, mimeType);
  } catch (err) {
    console.error('[Voice] Transcribe error:', err.message);
  }

  if (!transcript) return FALLBACK_VOICE;

  const cap = String(caption || '').trim();
  if (cap && transcript) {
    return `Подпись к аудио: ${cap}\nТранскрипция аудио: ${transcript}`;
  }
  return transcript;
}

async function transcribeVoice(normalized) {
  const result = await processVoice(normalized);
  return result.text;
}

async function processVoice(normalized) {
  try {
    const { buffer, mimeType } = await downloadVoice(normalized);
    // caption — для TG audio с подписью; image_caption/message выставляются normalize.js
    const caption = normalized.image_caption || normalized.message || '';
    const text = await transcribeVoiceBuffer(buffer, mimeType, caption);
    return {
      text,
      transcript: text === FALLBACK_VOICE ? null : text,
      processingStatus: text === FALLBACK_VOICE ? 'failed' : 'ready',
      processingError: text === FALLBACK_VOICE ? 'stt_empty_or_failed' : null,
      buffer,
      mimeType,
    };
  } catch (err) {
    console.error('[Voice] Download error:', err.message);
    return {
      text: FALLBACK_VOICE,
      transcript: null,
      processingStatus: 'failed',
      processingError: err.message,
      buffer: null,
      mimeType: normalized.voice_mime_type || 'audio/ogg',
    };
  }
}

module.exports = { transcribeVoice, processVoice, downloadVoice, transcribeVoiceBuffer, FALLBACK_VOICE };

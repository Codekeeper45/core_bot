'use strict';
const { transcribeAudio } = require('../services/openrouterMedia');
const tgClient = require('../channels/telegram');

const FALLBACK_VOICE = 'Клиент отправил голосовое сообщение, но распознать его не удалось. Вежливо попроси повторить голосом или написать текстом.';

async function transcribeVoice(normalized) {
  const { channel, voice_source_url, voice_file_id, voice_mime_type, baileys_media_obj } = normalized;

  let buffer;
  let mimeType = voice_mime_type || 'audio/ogg';

  try {
    if (channel === 'telegram') {
      const { buffer: buf } = await tgClient.downloadFile(voice_file_id);
      buffer = buf;
    } else if (baileys_media_obj) {
      // WhatsApp via Baileys — download encrypted media
      const baileys = require('../services/baileys');
      buffer = await baileys.downloadMedia(baileys_media_obj, 'audio');
      mimeType = baileys_media_obj.mimetype || 'audio/ogg; codecs=opus';
    } else if (channel === 'instagram' && voice_source_url) {
      // Instagram via Wazzup — use the Wazzup client (handles 401/403 fallback).
      const wazzup = require('../services/wazzup');
      const dl = await wazzup.downloadContent(voice_source_url);
      buffer = dl.buffer;
      if (dl.mimeType && dl.mimeType !== 'application/octet-stream') mimeType = dl.mimeType;
    } else if (voice_source_url) {
      // Fallback: direct URL (legacy GreenAPI path, kept for safety)
      const res = await fetch(voice_source_url);
      if (!res.ok) throw new Error(`Download failed: ${res.status}`);
      buffer = Buffer.from(await res.arrayBuffer());
    } else {
      throw new Error('No media source available for voice');
    }
  } catch (err) {
    console.error('[Voice] Download error:', err.message);
    return FALLBACK_VOICE;
  }

  let transcript = '';
  try {
    transcript = await transcribeAudio(buffer, mimeType);
  } catch (err) {
    console.error('[Voice] Transcribe error:', err.message);
  }

  if (!transcript) return FALLBACK_VOICE;

  const caption = normalized.image_caption || '';
  if (caption && transcript) {
    return `Подпись к аудио: ${caption}\nТранскрипция аудио: ${transcript}`;
  }
  return transcript;
}

module.exports = { transcribeVoice };

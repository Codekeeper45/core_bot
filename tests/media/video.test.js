'use strict';
// media/video: видео/кружок/гифка → Gemini-описание + Whisper-транскрипция; стикеры.
const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');

let analyzeCalls = [];
let transcribeCalls = [];
let analyzeVideoImpl = async () => 'человек показывает лоток DN100 на складе';
let analyzeImageImpl = async () => 'кот показывает большой палец — одобрение';
let transcribeImpl = async () => 'привет, нужен расчёт на десять метров';
const openrouterMediaMock = {
  analyzeVideoBase64: async (b64, mime, prompt) => { analyzeCalls.push({ kind: 'video', mime, prompt }); return analyzeVideoImpl(); },
  analyzeImageBase64: async (b64, mime, prompt) => { analyzeCalls.push({ kind: 'image', mime, prompt }); return analyzeImageImpl(); },
  transcribeAudio: async (buf, mime) => { transcribeCalls.push({ mime }); return transcribeImpl(); },
};
const counts = { video: 0 };
let checkLimitImpl = async () => false;
const mysqlMock = {
  checkDailyCount: async (...a) => checkLimitImpl(...a),
  incrementDailyCount: async () => { counts.video++; },
};
const tgMock = { downloadFile: async (id) => ({ buffer: Buffer.from(`tg-video-${id}`) }) };
const baileysMock = { downloadMedia: async (obj, type) => Buffer.from(`wa-${type}`) };

// Подмена require остаётся активной на весь файл: video.js требует baileys/wazzup
// ЛЕНИВО внутри функций (node:test изолирует файлы по процессам — это безопасно).
const orig = Module.prototype.require;
Module.prototype.require = function (id) {
  if (id === '../services/openrouterMedia') return openrouterMediaMock;
  if (id === '../services/mysql') return mysqlMock;
  if (id === '../channels/telegram') return tgMock;
  if (id === '../services/baileys') return baileysMock;
  return orig.apply(this, arguments);
};
delete require.cache[require.resolve('../../src/media/video')];
const { processVideo, processSticker } = require('../../src/media/video');

describe('processVideo', () => {
  beforeEach(() => {
    analyzeCalls = [];
    transcribeCalls = [];
    counts.video = 0;
    analyzeVideoImpl = async () => 'человек показывает лоток DN100 на складе';
    transcribeImpl = async () => 'привет, нужен расчёт на десять метров';
    checkLimitImpl = async () => false;
  });

  test('видео: описание Gemini + транскрипция Whisper в одном блоке', async () => {
    const r = await processVideo({ channel: 'telegram', chat_id: '1', message_type: 'video', video_file_id: 'V1', video_mime_type: 'video/mp4', message: 'смотри' });
    assert.ok(r.text.includes('[ВИДЕО]'));
    assert.ok(r.text.includes('подпись: смотри'));
    assert.ok(r.text.includes('описание: человек показывает лоток DN100'));
    assert.ok(r.text.includes('транскрипция речи: привет, нужен расчёт'));
    assert.equal(analyzeCalls[0].kind, 'video');
    assert.equal(analyzeCalls[0].mime, 'video/mp4');
    assert.equal(transcribeCalls.length, 1);
    assert.equal(counts.video, 1, 'дневной счётчик инкрементирован');
  });

  test('видеокружок помечается [ВИДЕОКРУЖОК]', async () => {
    const r = await processVideo({ channel: 'whatsapp', chat_id: '2', message_type: 'video_note', baileys_media_obj: {}, baileys_media_type: 'ptv', video_mime_type: 'video/mp4' });
    assert.ok(r.text.includes('[ВИДЕОКРУЖОК]'));
  });

  test('гифка: описание есть, транскрипции НЕТ (немая)', async () => {
    const r = await processVideo({ channel: 'telegram', chat_id: '1', message_type: 'animation', video_file_id: 'G1', video_mime_type: 'video/mp4' });
    assert.ok(r.text.includes('[ГИФКА]'));
    assert.equal(transcribeCalls.length, 0);
  });

  test('Gemini упал, Whisper сработал → блок только с транскрипцией', async () => {
    analyzeVideoImpl = async () => { throw new Error('video model down'); };
    const r = await processVideo({ channel: 'telegram', chat_id: '1', message_type: 'video', video_file_id: 'V2', video_mime_type: 'video/mp4' });
    assert.ok(!r.error);
    assert.ok(r.text.includes('транскрипция речи'));
    assert.ok(!r.text.includes('описание:'));
  });

  test('оба упали → честная ошибка', async () => {
    analyzeVideoImpl = async () => { throw new Error('down'); };
    transcribeImpl = async () => { throw new Error('down'); };
    const r = await processVideo({ channel: 'telegram', chat_id: '1', message_type: 'video', video_file_id: 'V3', video_mime_type: 'video/mp4' });
    assert.ok(r.error);
  });

  test('дневной лимит видео', async () => {
    checkLimitImpl = async () => true;
    const r = await processVideo({ channel: 'telegram', chat_id: '1', message_type: 'video', video_file_id: 'V4' });
    assert.ok(r.error);
    assert.match(r.error, /не больше/);
  });

  test('слишком большое видео → ошибка о размере', async () => {
    const config = require('../../src/config');
    tgMock.downloadFile = async () => ({ buffer: Buffer.alloc(config.VIDEO_MAX_MB * 1024 * 1024 + 1) });
    const r = await processVideo({ channel: 'telegram', chat_id: '1', message_type: 'video', video_file_id: 'V5' });
    assert.ok(r.error);
    assert.match(r.error, /слишком большое/);
    tgMock.downloadFile = async (id) => ({ buffer: Buffer.from(`tg-video-${id}`) });
  });
});

describe('processSticker', () => {
  beforeEach(() => { analyzeCalls = []; });

  test('webp-стикер → vision-описание с эмодзи', async () => {
    const r = await processSticker({ channel: 'telegram', chat_id: '1', video_file_id: 'S1', sticker_emoji: '👍', sticker_format: 'webp' });
    assert.ok(r.text.includes('[СТИКЕР (эмодзи: 👍)]'));
    assert.ok(r.text.includes('кот показывает большой палец'));
    assert.equal(analyzeCalls[0].kind, 'image');
    assert.equal(analyzeCalls[0].mime, 'image/webp');
  });

  test('видео-стикер webm идёт через видео-модель', async () => {
    const r = await processSticker({ channel: 'telegram', chat_id: '1', video_file_id: 'S2', sticker_format: 'webm' });
    assert.equal(analyzeCalls[0].kind, 'video');
    assert.equal(analyzeCalls[0].mime, 'video/webm');
    assert.ok(r.text.includes('[СТИКЕР]'));
  });

  test('tgs (lottie) → фолбэк на эмодзи без скачивания', async () => {
    const r = await processSticker({ channel: 'telegram', chat_id: '1', sticker_emoji: '😂', sticker_format: 'tgs' });
    assert.ok(r.text.includes('😂'));
    assert.equal(analyzeCalls.length, 0);
  });

  test('vision упал → фолбэк-текст, не исключение', async () => {
    analyzeImageImpl = async () => { throw new Error('down'); };
    const r = await processSticker({ channel: 'whatsapp', chat_id: '1', baileys_media_obj: {}, baileys_media_type: 'sticker', sticker_format: 'webp' });
    assert.ok(r.text.includes('[СТИКЕР]'));
    assert.match(r.text, /не удалось/);
  });
});

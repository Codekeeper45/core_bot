'use strict';

// Set env vars before requiring config-dependent modules so blocked/excluded tests work
process.env.BLOCKED_PHONES = '87771351258';
process.env.EXCLUDED_CHAT_ID = '77073230970@s.whatsapp.net';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { normalizeInbound } = require('../src/channels/normalize');

// ─── Baileys WhatsApp fixtures ───
const WA_TEXT = {
  __baileys: true,
  baileysMsg: {
    key: { remoteJid: '77071234567@s.whatsapp.net', fromMe: false, id: 'ABC123' },
    pushName: 'Иван Иванов',
    message: { conversation: 'Нужен лоток DN100' },
  },
};

const WA_OUTGOING = {
  __baileys: true,
  baileysMsg: {
    key: { remoteJid: '77071234567@s.whatsapp.net', fromMe: true, id: 'X' },
    pushName: 'Bot',
    message: { conversation: 'outgoing' },
  },
};

const WA_BLOCKED = {
  __baileys: true,
  baileysMsg: {
    key: { remoteJid: '87771351258@s.whatsapp.net', fromMe: false, id: 'Y' },
    pushName: 'Blocked',
    message: { conversation: 'test' },
  },
};

const WA_EXCLUDED = {
  __baileys: true,
  baileysMsg: {
    key: { remoteJid: '77073230970@s.whatsapp.net', fromMe: false, id: 'Z' },
    pushName: 'Excluded',
    message: { conversation: 'hi' },
  },
};

const WA_VOICE = {
  __baileys: true,
  baileysMsg: {
    key: { remoteJid: '77071234567@s.whatsapp.net', fromMe: false, id: 'V1' },
    pushName: 'Иван',
    message: {
      audioMessage: { mimetype: 'audio/ogg; codecs=opus', seconds: 5, ptt: true },
    },
  },
};

const WA_IMAGE = {
  __baileys: true,
  baileysMsg: {
    key: { remoteJid: '77071234567@s.whatsapp.net', fromMe: false, id: 'I1' },
    pushName: 'Иван',
    message: {
      imageMessage: { caption: 'Фото участка', mimetype: 'image/jpeg' },
    },
  },
};

const WA_DOC = {
  __baileys: true,
  baileysMsg: {
    key: { remoteJid: '77071234567@s.whatsapp.net', fromMe: false, id: 'D1' },
    pushName: 'Иван',
    message: {
      documentMessage: { fileName: 'проект.pdf', mimetype: 'application/pdf' },
    },
  },
};

// ─── Telegram fixtures (unchanged) ───
const TG_TEXT = { update_id: 123, message: { message_id: 1, from: { id: 12345, first_name: 'Алексей', username: 'alex' }, chat: { id: 12345, type: 'private' }, text: 'Привет' } };
const TG_PHOTO = { update_id: 124, message: { message_id: 2, from: { id: 12345, first_name: 'Алексей' }, chat: { id: 12345, type: 'private' }, photo: [{ file_id: 'small', width: 90 }, { file_id: 'large', width: 800, file_unique_id: 'uid' }], caption: 'Вот фото' } };
const TG_VOICE = { update_id: 125, message: { message_id: 3, from: { id: 12345, first_name: 'Алексей' }, chat: { id: 12345, type: 'private' }, voice: { file_id: 'voice123', duration: 5, mime_type: 'audio/ogg' } } };
const TG_DOC = { update_id: 126, message: { message_id: 4, from: { id: 12345, first_name: 'Алексей' }, chat: { id: 12345, type: 'private' }, document: { file_id: 'doc123', file_name: 'file.pdf', mime_type: 'application/pdf', file_size: 100000 } } };
const TG_DOC_IMAGE = { update_id: 127, message: { message_id: 5, from: { id: 12345, first_name: 'Алексей' }, chat: { id: 12345, type: 'private' }, document: { file_id: 'docimg', file_name: 'photo.png', mime_type: 'image/png' } } };
const TG_GROUP = { update_id: 128, message: { message_id: 6, from: { id: 12345, first_name: 'Алексей' }, chat: { id: -100500, type: 'group' }, text: 'Групповое' } };

describe('normalizeInbound — WhatsApp (Baileys)', () => {
  test('текстовое сообщение — channel=whatsapp, is_supported=true, текст извлечён', () => {
    const r = normalizeInbound(WA_TEXT);
    assert.equal(r.channel, 'whatsapp');
    assert.equal(r.message_type, 'text');
    assert.equal(r.is_supported, true);
    assert.equal(r.message, 'Нужен лоток DN100');
    assert.equal(r.chat_id, '77071234567@s.whatsapp.net');
  });

  test('исходящее сообщение — is_supported=false, is_outgoing=true', () => {
    const r = normalizeInbound(WA_OUTGOING);
    assert.equal(r.is_supported, false);
    assert.equal(r.is_outgoing, true);
  });

  test('заблокированный номер — is_supported=false, unsupported_reason=blocked', () => {
    const r = normalizeInbound(WA_BLOCKED);
    assert.equal(r.is_supported, false);
    assert.equal(r.unsupported_reason, 'blocked');
  });

  test('исключённый chat_id — is_supported=false', () => {
    const r = normalizeInbound(WA_EXCLUDED);
    assert.equal(r.is_supported, false);
  });

  test('голосовое — message_type=voice, has_voice=true', () => {
    const r = normalizeInbound(WA_VOICE);
    assert.equal(r.message_type, 'voice');
    assert.equal(r.has_voice, true);
    assert.equal(r.is_supported, true);
  });

  test('изображение — message_type=image, caption заполнен', () => {
    const r = normalizeInbound(WA_IMAGE);
    assert.equal(r.message_type, 'image');
    assert.equal(r.has_image, true);
    assert.equal(r.image_caption, 'Фото участка');
    assert.equal(r.is_supported, true);
  });

  test('документ PDF — message_type=document, family=pdf', () => {
    const r = normalizeInbound(WA_DOC);
    assert.equal(r.message_type, 'document');
    assert.equal(r.document_family, 'pdf');
    assert.equal(r.document_file_name, 'проект.pdf');
    assert.equal(r.is_supported, true);
  });
});

describe('normalizeInbound — Telegram', () => {
  test('текстовое сообщение — channel=telegram, is_supported=true', () => {
    const r = normalizeInbound(TG_TEXT);
    assert.equal(r.channel, 'telegram');
    assert.equal(r.message_type, 'text');
    assert.equal(r.is_supported, true);
    assert.equal(r.message, 'Привет');
    assert.equal(r.chat_id, '12345');
  });

  test('фото — берётся последний (наибольший) файл', () => {
    const r = normalizeInbound(TG_PHOTO);
    assert.equal(r.message_type, 'image');
    assert.equal(r.has_image, true);
    assert.equal(r.image_source, 'tg:large');
    assert.equal(r.image_caption, 'Вот фото');
  });

  test('голосовое — message_type=voice, voice_file_id заполнен', () => {
    const r = normalizeInbound(TG_VOICE);
    assert.equal(r.message_type, 'voice');
    assert.equal(r.voice_file_id, 'voice123');
    assert.equal(r.is_supported, true);
  });

  test('документ PDF — message_type=document, family=pdf', () => {
    const r = normalizeInbound(TG_DOC);
    assert.equal(r.message_type, 'document');
    assert.equal(r.document_family, 'pdf');
  });

  test('документ с mime image/ — обрабатывается как image', () => {
    const r = normalizeInbound(TG_DOC_IMAGE);
    assert.equal(r.message_type, 'image');
    assert.equal(r.image_source, 'tg:docimg');
  });

  test('групповой чат — is_private=false, is_supported=false', () => {
    const r = normalizeInbound(TG_GROUP);
    assert.equal(r.is_private, false);
    assert.equal(r.is_supported, false);
  });
});

// ─── LID-режим новых Baileys: remoteJid='...@lid', телефон в remoteJidAlt ───
test('normalizeInbound — WA LID: chat_id берётся из телефонного JID (remoteJidAlt)', () => {
  const r = normalizeInbound({
    __baileys: true,
    baileysMsg: {
      key: {
        remoteJid: '123456789012345@lid',
        remoteJidAlt: '77775477227@s.whatsapp.net',
        fromMe: false, id: 'LID1',
      },
      pushName: 'Босс',
      message: { conversation: 'привет' },
    },
  });
  assert.equal(r.chat_id, '77775477227@s.whatsapp.net'); // НЕ @lid
  assert.equal(r.phone, '77775477227');
  assert.equal(r.is_supported, true);
});

test('normalizeInbound — WA LID без remoteJidAlt: остаётся lid, но не падает', () => {
  const r = normalizeInbound({
    __baileys: true,
    baileysMsg: {
      key: { remoteJid: '123456789012345@lid', fromMe: false, id: 'LID2' },
      pushName: 'Кто-то',
      message: { conversation: 'тест' },
    },
  });
  assert.equal(r.chat_id, '123456789012345@lid');
  assert.equal(r.is_supported, true);
});

// ─── Мультимодальность: видео / кружки / гифки / стикеры ───
describe('normalizeInbound — видео-подобные типы', () => {
  test('TG video → message_type=video, file_id/mime заполнены', () => {
    const n = normalizeInbound({ update_id: 1, message: {
      message_id: 5, chat: { id: 10, type: 'private' }, from: { first_name: 'A' },
      video: { file_id: 'V1', mime_type: 'video/mp4', duration: 12 }, caption: 'смотри',
    } });
    assert.equal(n.message_type, 'video');
    assert.equal(n.has_video, true);
    assert.equal(n.video_file_id, 'V1');
    assert.equal(n.video_mime_type, 'video/mp4');
    assert.equal(n.message, 'смотри');
    assert.equal(n.is_supported, true);
  });

  test('TG video_note → message_type=video_note', () => {
    const n = normalizeInbound({ update_id: 1, message: {
      message_id: 5, chat: { id: 10, type: 'private' }, from: { first_name: 'A' },
      video_note: { file_id: 'VN1', duration: 30 },
    } });
    assert.equal(n.message_type, 'video_note');
    assert.equal(n.message_text_for_buffer, '[видеокружок]');
    assert.equal(n.is_supported, true);
  });

  test('TG animation (гифка) → message_type=animation', () => {
    const n = normalizeInbound({ update_id: 1, message: {
      message_id: 5, chat: { id: 10, type: 'private' }, from: { first_name: 'A' },
      animation: { file_id: 'G1', mime_type: 'video/mp4' },
    } });
    assert.equal(n.message_type, 'animation');
    assert.equal(n.message_text_for_buffer, '[гифка]');
  });

  test('TG sticker: статичный webp / анимированный tgs / видео webm', () => {
    const base = { message_id: 5, chat: { id: 10, type: 'private' }, from: { first_name: 'A' } };
    const st = normalizeInbound({ update_id: 1, message: { ...base, sticker: { file_id: 'S1', emoji: '👍' } } });
    assert.equal(st.message_type, 'sticker');
    assert.equal(st.sticker_format, 'webp');
    assert.equal(st.sticker_emoji, '👍');
    assert.equal(st.message_text_for_buffer, '[стикер 👍]');
    const tgs = normalizeInbound({ update_id: 1, message: { ...base, sticker: { file_id: 'S2', is_animated: true } } });
    assert.equal(tgs.sticker_format, 'tgs');
    const webm = normalizeInbound({ update_id: 1, message: { ...base, sticker: { file_id: 'S3', is_video: true } } });
    assert.equal(webm.sticker_format, 'webm');
  });

  test('TG document с mime video/ → video', () => {
    const n = normalizeInbound({ update_id: 1, message: {
      message_id: 5, chat: { id: 10, type: 'private' }, from: { first_name: 'A' },
      document: { file_id: 'D1', file_name: 'clip.mp4', mime_type: 'video/mp4' },
    } });
    assert.equal(n.message_type, 'video');
    assert.equal(n.original_message_type, 'document_video');
  });

  test('WA videoMessage → video; gifPlayback → animation; ptvMessage → video_note', () => {
    const key = { remoteJid: '77071234567@s.whatsapp.net', fromMe: false, id: 'V' };
    const vid = normalizeInbound({ __baileys: true, baileysMsg: { key, pushName: 'И', message: { videoMessage: { mimetype: 'video/mp4', seconds: 9, caption: 'вот' } } } });
    assert.equal(vid.message_type, 'video');
    assert.equal(vid.baileys_media_type, 'video');
    assert.equal(vid.message, 'вот');
    assert.equal(vid.is_supported, true);
    const gif = normalizeInbound({ __baileys: true, baileysMsg: { key, pushName: 'И', message: { videoMessage: { mimetype: 'video/mp4', gifPlayback: true } } } });
    assert.equal(gif.message_type, 'animation');
    const ptv = normalizeInbound({ __baileys: true, baileysMsg: { key, pushName: 'И', message: { ptvMessage: { mimetype: 'video/mp4', seconds: 15 } } } });
    assert.equal(ptv.message_type, 'video_note');
    assert.equal(ptv.baileys_media_type, 'ptv');
  });

  test('WA stickerMessage → sticker (webp)', () => {
    const key = { remoteJid: '77071234567@s.whatsapp.net', fromMe: false, id: 'S' };
    const n = normalizeInbound({ __baileys: true, baileysMsg: { key, pushName: 'И', message: { stickerMessage: { mimetype: 'image/webp' } } } });
    assert.equal(n.message_type, 'sticker');
    assert.equal(n.sticker_format, 'webp');
    assert.equal(n.baileys_media_type, 'sticker');
    assert.equal(n.is_supported, true);
  });

  test('IG video теперь ПОДДЕРЖИВАЕТСЯ (contentUri → video_source_url)', () => {
    const n = normalizeInbound({ __wazzup: true, wazzupMsg: {
      chatType: 'instagram', chatId: 'user1', messageId: 'm1', type: 'video',
      contentUri: 'https://cdn/x.mp4', text: 'глянь',
    } });
    assert.equal(n.message_type, 'video');
    assert.equal(n.video_source_url, 'https://cdn/x.mp4');
    assert.equal(n.is_supported, true);
    assert.equal(n.unsupported_canned_message, null);
  });
});

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

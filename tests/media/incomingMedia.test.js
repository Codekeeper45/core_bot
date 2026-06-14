'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

// Моки каналов: проверяем, что downloadIncoming диспетчеризует по каналу-источнику.
const baileysMock = { downloadMedia: async (obj, type) => Buffer.from(`wa:${type}`) };
const tgMock = { downloadFile: async (fileId) => ({ buffer: Buffer.from(`tg:${fileId}`), url: 'u' }) };
const wazzupMock = { downloadContent: async (url) => ({ buffer: Buffer.from(`ig:${url}`), mimeType: 'image/png' }) };

const Module = require('module');
const orig = Module.prototype.require;
Module.prototype.require = function (id) {
  if (id === '../services/baileys') return baileysMock;
  if (id === '../channels/telegram') return tgMock;
  if (id === '../services/wazzup') return wazzupMock;
  return orig.apply(this, arguments);
};
delete require.cache[require.resolve('../../src/media/incomingMedia')];
const { downloadIncoming } = require('../../src/media/incomingMedia');
Module.prototype.require = orig;

describe('downloadIncoming: диспетчеризация по каналу', () => {
  test('telegram: file_id', async () => {
    const r = await downloadIncoming({ type: 'document', channel: 'telegram', file_id: 'F9', file_name: 'a.pdf' });
    assert.equal(r.buffer.toString(), 'tg:F9');
    assert.equal(r.fileName, 'a.pdf');
  });

  test('telegram: ref вида tg:<id>', async () => {
    const r = await downloadIncoming({ type: 'image', channel: 'telegram', ref: 'tg:ABC' });
    assert.equal(r.buffer.toString(), 'tg:ABC');
  });

  test('whatsapp: baileys_media_obj, voice → audio', async () => {
    const r = await downloadIncoming({ type: 'voice', channel: 'whatsapp', baileys_media_obj: {} });
    assert.equal(r.buffer.toString(), 'wa:audio');
  });

  test('whatsapp: image → image', async () => {
    const r = await downloadIncoming({ type: 'image', channel: 'whatsapp', baileys_media_obj: {} });
    assert.equal(r.buffer.toString(), 'wa:image');
  });

  test('instagram: source_url', async () => {
    const r = await downloadIncoming({ type: 'image', channel: 'instagram', source_url: 'https://x/y.jpg' });
    assert.equal(r.buffer.toString(), 'ig:https://x/y.jpg');
    assert.equal(r.mime, 'image/png');
  });

  test('нет идентификатора → понятная ошибка', async () => {
    await assert.rejects(() => downloadIncoming({ type: 'document', channel: 'telegram' }), /file_id/);
    await assert.rejects(() => downloadIncoming({ type: 'image', channel: 'whatsapp' }), /baileys_media_obj/);
    await assert.rejects(() => downloadIncoming({ type: 'image', channel: 'unknown' }), /неизвестный канал/);
  });
});

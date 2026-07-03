'use strict';
// notifier.deliver: маршрутизация новых видов медиа (видео/кружок/гифка/стикер)
// в правильные методы каналов Telegram и WhatsApp.
const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const calls = [];
const rec = (name) => async (...args) => { calls.push({ name, args }); return true; };
const tgMock = {
  sendMessage: rec('tg.sendMessage'), sendPhoto: rec('tg.sendPhoto'), sendVoice: rec('tg.sendVoice'),
  sendDocument: rec('tg.sendDocument'), sendVideo: rec('tg.sendVideo'), sendVideoNote: rec('tg.sendVideoNote'),
  sendAnimation: rec('tg.sendAnimation'), sendSticker: rec('tg.sendSticker'),
};
const waMock = {
  sendMessage: rec('wa.sendMessage'), sendImage: rec('wa.sendImage'), sendVoice: rec('wa.sendVoice'),
  sendDocument: rec('wa.sendDocument'), sendVideo: rec('wa.sendVideo'), sendSticker: rec('wa.sendSticker'),
};

const Module = require('module');
const orig = Module.prototype.require;
Module.prototype.require = function (id) {
  if (id === './mysql') return { getProject: async () => null };
  if (id === '../channels/telegram') return tgMock;
  if (id === '../services/baileys') return waMock;
  if (id === '../channels/instagram') return { sendMessage: rec('ig.sendMessage') };
  if (id === '../agent/memory') return { recordOutbound: async () => {} };
  return orig.apply(this, arguments);
};
delete require.cache[require.resolve('../src/services/notifier')];
const notifier = require('../src/services/notifier');

const buf = Buffer.from('x');
const last = () => calls[calls.length - 1];

describe('deliver: новые виды медиа → верные методы каналов', () => {
  beforeEach(() => { calls.length = 0; });

  test('telegram: video / video_note / animation / sticker', async () => {
    await notifier.deliver('telegram', '5', 'подпись', { kind: 'video', buffer: buf });
    assert.equal(last().name, 'tg.sendVideo');

    await notifier.deliver('telegram', '5', '', { kind: 'video_note', buffer: buf });
    assert.equal(last().name, 'tg.sendVideoNote');

    await notifier.deliver('telegram', '5', '', { kind: 'animation', buffer: buf });
    assert.equal(last().name, 'tg.sendAnimation');

    await notifier.deliver('telegram', '5', '', { kind: 'sticker', buffer: buf, mimetype: 'image/webp' });
    assert.equal(last().name, 'tg.sendSticker');
  });

  test('whatsapp: video с подписью; кружок → ptv; гифка → gifPlayback', async () => {
    await notifier.deliver('whatsapp', '77070001122', 'подпись', { kind: 'video', buffer: buf });
    assert.equal(last().name, 'wa.sendVideo');
    assert.equal(last().args[2].caption, 'подпись');

    await notifier.deliver('whatsapp', '77070001122', '', { kind: 'video_note', buffer: buf });
    assert.equal(last().name, 'wa.sendVideo');
    assert.equal(last().args[2].ptv, true);

    await notifier.deliver('whatsapp', '77070001122', '', { kind: 'animation', buffer: buf });
    assert.equal(last().name, 'wa.sendVideo');
    assert.equal(last().args[2].gifPlayback, true);
  });

  test('whatsapp: webp-стикер → sendSticker; webm-стикер → документом (WA его не примет)', async () => {
    await notifier.deliver('whatsapp', '77070001122', '', { kind: 'sticker', buffer: buf, mimetype: 'image/webp' });
    assert.equal(last().name, 'wa.sendSticker');

    await notifier.deliver('whatsapp', '77070001122', '', { kind: 'sticker', buffer: buf, mimetype: 'video/webm', fileName: 'sticker.webm' });
    assert.equal(last().name, 'wa.sendDocument');
  });

  test('instagram: медиа деградирует в текст (как раньше)', async () => {
    await notifier.deliver('instagram', 'user1', '', { kind: 'video', buffer: buf, caption: 'видео от клиента' });
    assert.equal(last().name, 'ig.sendMessage');
  });

  test('describeMedia в записи истории: видеокружок', async () => {
    const recorded = [];
    Module.prototype.require = function (id) {
      if (id === '../agent/memory') return { recordOutbound: async (ch, key, text) => { recorded.push(text); } };
      if (id === './mysql') return { getProject: async () => null };
      if (id === '../channels/telegram') return tgMock;
      if (id === '../services/baileys') return waMock;
      if (id === '../channels/instagram') return { sendMessage: rec('ig.sendMessage') };
      return orig.apply(this, arguments);
    };
    await notifier.deliver('telegram', '5', '', { kind: 'video_note', buffer: buf }, { record: true });
    assert.deepEqual(recorded, ['[видеокружок]']);
  });
});

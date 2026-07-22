'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');

let transcript = '';
let imageDescription = '';
let lastImage = null;
let savedAudio = null;
let savedTranscript = null;

const originalRequire = Module.prototype.require;
Module.prototype.require = function (id) {
  if (id === '../media/voice') {
    return {
      FALLBACK_VOICE: 'fallback voice',
      downloadVoice: async () => ({ buffer: Buffer.from('audio'), mimeType: 'audio/ogg' }),
      transcribeVoiceBuffer: async () => transcript,
    };
  }
  if (id === '../media/image') {
    return {
      describeImage: async (image) => {
        lastImage = image;
        return imageDescription;
      },
    };
  }
  if (id === './mysql') {
    return {
      storeObservedGroupAudio: async (payload) => { savedAudio = payload; return 1; },
      saveObservedGroupAudioTranscript: async (id, value) => { savedTranscript = { id, value }; },
    };
  }
  return originalRequire.apply(this, arguments);
};
delete require.cache[require.resolve('../../src/services/groupObserver')];
const { observedMessageContent } = require('../../src/services/groupObserver');
Module.prototype.require = originalRequire;

describe('observedMessageContent', () => {
  test('архивирует транскрипцию голосового', async () => {
    transcript = 'Машина будет на складе завтра утром.';
    savedAudio = null;
    savedTranscript = null;
    const content = await observedMessageContent({
      message_type: 'voice', channel: 'whatsapp', chat_id: '120@g.us', message_id: 'voice-1', client_name: 'Заиндин',
    });
    assert.equal(content, '[ГОЛОСОВОЕ]\nТранскрипция: Машина будет на складе завтра утром.');
    assert.equal(savedAudio.sourceMessageId, 'voice-1');
    assert.equal(savedAudio.actorName, 'Заиндин');
    assert.deepEqual(savedAudio.buffer, Buffer.from('audio'));
    assert.deepEqual(savedTranscript, { id: 1, value: 'Машина будет на складе завтра утром.' });
  });

  test('честно отмечает голосовое без транскрипции', async () => {
    transcript = 'fallback voice';
    const content = await observedMessageContent({ message_type: 'voice', channel: 'whatsapp' });
    assert.match(content, /Оригинал сохранён/);
  });

  test('архивирует описание изображения и передаёт Baileys media object', async () => {
    imageDescription = 'На фото паллеты с лотками DN100.';
    const media = { mimetype: 'image/jpeg' };
    const content = await observedMessageContent({
      message_type: 'image', channel: 'whatsapp', image_source: 'wa-baileys',
      image_caption: 'Приёмка', baileys_media_obj: media,
    });
    assert.match(content, /Подпись: Приёмка/);
    assert.match(content, /паллеты с лотками DN100/);
    assert.equal(lastImage.baileys_media_obj, media);
  });

  test('обычный текст не запускает обработку медиа', async () => {
    const content = await observedMessageContent({ message_type: 'text', message: 'Машина выехала' });
    assert.equal(content, 'Машина выехала');
  });
});

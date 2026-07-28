'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const config = require('../src/config');
config.BUFFER_WAIT = 5; // ускоряем окно склейки для теста
const { bufferAndCollect } = require('../src/middleware/buffer');

describe('bufferAndCollect: buffered_media', () => {
  test('собирает вложения батча (image/document/voice), пропускает записи без media', async () => {
    const r = await bufferAndCollect('whatsapp:chatA', {
      timestamp: Date.now(),
      content: 'смотри файл',
      img_url: null,
      baileys_media_obj: null,
      media: { type: 'document', channel: 'whatsapp', file_name: 'смета.pdf' },
    });
    assert.ok(r, 'батч завершился');
    assert.equal(r.buffered_media.length, 1);
    assert.equal(r.buffered_media[0].type, 'document');
    assert.equal(r.combined_message, 'смотри файл');
  });

  test('текст без media → buffered_media пуст', async () => {
    const r = await bufferAndCollect('whatsapp:chatB', {
      timestamp: Date.now(), content: 'просто текст', img_url: null, baileys_media_obj: null, media: null,
    });
    assert.ok(r);
    assert.equal(r.buffered_media.length, 0);
  });

  test('сохраняет отдельные канонические конверты сообщений', async () => {
    const key = `envelope-${Date.now()}`;
    const first = bufferAndCollect(key, {
      timestamp: 1,
      content: 'транскрипция',
      envelope: { message_type: 'voice', message_id: 'v1', processed_text: 'транскрипция' },
    });
    await new Promise((resolve) => setTimeout(resolve, 1));
    const second = bufferAndCollect(key, {
      timestamp: 2,
      content: 'ответ',
      envelope: { message_type: 'text', message_id: 't2', processed_text: 'ответ' },
    });
    assert.equal(await first, null);
    const result = await second;
    assert.deepEqual(result.messages.map((m) => m.message_id), ['v1', 't2']);
    assert.deepEqual(result.messages.map((m) => m.message_type), ['voice', 'text']);
  });
});

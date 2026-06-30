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
});

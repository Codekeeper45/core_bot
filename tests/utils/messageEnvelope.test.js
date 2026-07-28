'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { archiveContent, renderBatch } = require('../../src/utils/messageEnvelope');

describe('messageEnvelope', () => {
  test('voice keeps its type, provider id, transcript and media id', () => {
    const rendered = renderBatch([{
      message_type: 'voice',
      original_message_type: 'ptt',
      message_id: 'wa-42',
      media_id: 7,
      processed_text: 'Завтра отгрузим 20 лотков.',
      processing_status: 'ready',
    }]);
    assert.match(rendered, /Тип: голосовое \(исходный: ptt\)/);
    assert.match(rendered, /ID сообщения: wa-42/);
    assert.match(rendered, /ID сохранённого медиа: 7/);
    assert.match(rendered, /Транскрипция: Завтра отгрузим 20 лотков/);
  });

  test('reply metadata and message boundaries are explicit', () => {
    const rendered = renderBatch([
      { message_type: 'text', message_id: '1', processed_text: 'Первое' },
      {
        message_type: 'text',
        message_id: '2',
        processed_text: 'Да',
        reply_to_message_id: '1',
        reply_to_message_type: 'voice',
        reply_to_text: '[голосовое сообщение]',
      },
    ]);
    assert.match(rendered, /\[КОНЕЦ СООБЩЕНИЯ 1\]/);
    assert.match(rendered, /\[ВХОДЯЩЕЕ СООБЩЕНИЕ 2\]/);
    assert.match(rendered, /Ответ на: ID 1, тип голосовое/);
  });

  test('failed voice is not converted to an ordinary text message', () => {
    const archived = archiveContent({
      message_type: 'voice',
      processed_text: 'Распознать не удалось.',
      processing_status: 'failed',
    });
    assert.match(archived, /^\[ГОЛОСОВОЕ\]/);
    assert.match(archived, /failed/);
    assert.match(archived, /Распознать не удалось/);
  });
});

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

test('контекст разработчику ограничен 10 сообщениями и скрывает секреты', () => {
  const { buildSafeTranscript } = require('../src/services/developerFeedback');
  const messages = Array.from({ length: 12 }, (_, i) => ({ role: 'user', content: `m${i}` }));
  messages.push({ role: 'assistant', content: 'OPENROUTER_API_KEY=sk-secret password=hunter2' });
  const text = buildSafeTranscript(messages, 10);
  assert.doesNotMatch(text, /sk-secret|hunter2/);
  assert.match(text, /OPENROUTER_API_KEY=\[REDACTED\]/);
  assert.doesNotMatch(text, /Пользователь: m(?:0|1|2)(?:\n|$)/);
  assert.match(text, /m3/);
});

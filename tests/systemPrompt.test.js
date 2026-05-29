'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { getSystemPrompt } = require('../src/agent/systemPrompt');

test('getSystemPrompt includes user context', () => {
  const prompt = getSystemPrompt('Иван', '77771234567', 'whatsapp');
  assert.ok(prompt.includes('Иван'));
  assert.ok(prompt.includes('77771234567'));
  assert.ok(prompt.includes('whatsapp'));
});

test('getSystemPrompt handles missing client name', () => {
  const prompt = getSystemPrompt('', '77771234567', 'whatsapp');
  assert.ok(prompt.includes('77771234567'));
});

test('getSystemPrompt includes system prompt content', () => {
  const prompt = getSystemPrompt('Иван', '77771234567', 'whatsapp');
  assert.ok(prompt.includes('консультант'));
});

'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert');
const Module = require('module');

const mysqlMock = {
  findEmployeeByContact: async () => null,
  getOpenTasksForEmployee: async () => [],
  listFacts: async () => [],
};
const orig = Module.prototype.require;
Module.prototype.require = function (id) {
  if (id === '../services/mysql') return mysqlMock;
  return orig.apply(this, arguments);
};
delete require.cache[require.resolve('../src/agent/systemPrompt')];
const { getSystemPrompt } = require('../src/agent/systemPrompt');
after(() => { Module.prototype.require = orig; });

test('getSystemPrompt includes user context', async () => {
  const prompt = await getSystemPrompt('Иван', '77771234567', 'whatsapp');
  assert.ok(prompt.includes('Иван'));
  assert.ok(prompt.includes('77771234567'));
  assert.ok(prompt.includes('whatsapp'));
});

test('getSystemPrompt handles missing client name', async () => {
  const prompt = await getSystemPrompt('', '77771234567', 'whatsapp');
  assert.ok(prompt.includes('77771234567'));
});

test('getSystemPrompt includes orchestrator persona', async () => {
  const prompt = await getSystemPrompt('Иван', '77771234567', 'whatsapp');
  assert.ok(prompt.includes('оркестратор'));
});

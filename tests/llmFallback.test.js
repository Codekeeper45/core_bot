'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const config = require('../src/config');
const { llmCreateWithFallback, getAgentMetrics } = require('../src/agent/agent');

config.OPENROUTER_MODEL = 'primary/model';
config.OPENROUTER_FALLBACK_MODEL = 'qwen/qwen3.6-plus';
const NO_DELAY = { maxRetries: 1, baseDelay: 1 }; // 1 attempt, no backoff

function clientThatFailsModels(failModels, calls) {
  return {
    chat: { completions: { create: async (params) => {
      calls.push(params.model);
      if (failModels.includes(params.model)) throw new Error(`provider down for ${params.model}`);
      return { choices: [{ message: { content: `ok from ${params.model}` } }] };
    } } },
  };
}

test('primary works → fallback not used', async () => {
  const calls = [];
  const c = clientThatFailsModels([], calls);
  const r = await llmCreateWithFallback((model) => ({ model }), NO_DELAY, c);
  assert.strictEqual(r.choices[0].message.content, 'ok from primary/model');
  assert.deepStrictEqual(calls, ['primary/model']);
});

test('primary fails → backup model serves the request', async () => {
  const calls = [];
  const before = getAgentMetrics().fallback_model_used;
  const c = clientThatFailsModels(['primary/model'], calls);
  const r = await llmCreateWithFallback((model) => ({ model }), NO_DELAY, c);
  assert.strictEqual(r.choices[0].message.content, 'ok from qwen/qwen3.6-plus');
  assert.deepStrictEqual(calls, ['primary/model', 'qwen/qwen3.6-plus']);
  assert.strictEqual(getAgentMetrics().fallback_model_used, before + 1);
});

test('both models fail → error propagates (caller escalates)', async () => {
  const calls = [];
  const c = clientThatFailsModels(['primary/model', 'qwen/qwen3.6-plus'], calls);
  await assert.rejects(
    () => llmCreateWithFallback((model) => ({ model }), NO_DELAY, c),
    /provider down for qwen\/qwen3\.6-plus/
  );
  assert.deepStrictEqual(calls, ['primary/model', 'qwen/qwen3.6-plus']);
});

test('no fallback configured → primary error propagates, no second attempt', async () => {
  const saved = config.OPENROUTER_FALLBACK_MODEL;
  config.OPENROUTER_FALLBACK_MODEL = '';
  const calls = [];
  const c = clientThatFailsModels(['primary/model'], calls);
  await assert.rejects(() => llmCreateWithFallback((model) => ({ model }), NO_DELAY, c));
  assert.deepStrictEqual(calls, ['primary/model']);
  config.OPENROUTER_FALLBACK_MODEL = saved;
});

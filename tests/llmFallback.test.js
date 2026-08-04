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

test('ответ 200 без choices (бесплатная модель/лимит) → трактуется как сбой, fallback', async () => {
  // primary отдаёт HTTP 200, но тело без choices (часто { error: {...} }) — раньше это
  // ломало агента в unexpected_error; теперь считается сбоем провайдера.
  const calls = [];
  const c = {
    chat: { completions: { create: async (params) => {
      calls.push(params.model);
      if (params.model === 'primary/model') return { error: { message: 'rate limited' } };
      return { choices: [{ message: { content: `ok from ${params.model}` } }] };
    } } },
  };
  const r = await llmCreateWithFallback((model) => ({ model }), NO_DELAY, c);
  assert.strictEqual(r.choices[0].message.content, 'ok from qwen/qwen3.6-plus');
  assert.deepStrictEqual(calls, ['primary/model', 'qwen/qwen3.6-plus']);
});

test('оба провайдера вернули тело без choices → ошибка пробрасывается (caller → FALLBACK_BUSY)', async () => {
  const c = {
    chat: { completions: { create: async () => ({ error: { message: 'no endpoints' } }) } },
  };
  await assert.rejects(
    () => llmCreateWithFallback((model) => ({ model }), NO_DELAY, c),
    /некорректный ответ|no endpoints/
  );
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

test('умная цепочка главного мозга: OpenRouter → DeepSeek → AnyModel → openrouter/free', () => {
  const { _internals } = require('../src/agent/agent');
  const saved = {
    DEEPSEEK_API_KEY: config.DEEPSEEK_API_KEY,
    OPENROUTER_API_KEY: config.OPENROUTER_API_KEY,
    ANYMODEL_API_KEY: config.ANYMODEL_API_KEY,
    DEEPSEEK_MODEL: config.DEEPSEEK_MODEL,
    OPENROUTER_MODEL: config.OPENROUTER_MODEL,
    OPENROUTER_FALLBACK_MODEL: config.OPENROUTER_FALLBACK_MODEL,
    ANYMODEL_MODEL: config.ANYMODEL_MODEL,
  };
  try {
    config.DEEPSEEK_API_KEY = 'ds';
    config.OPENROUTER_API_KEY = 'or';
    config.ANYMODEL_API_KEY = 'am';
    config.DEEPSEEK_MODEL = 'deepseek-v4-flash';
    config.OPENROUTER_MODEL = 'deepseek/deepseek-v4-flash-0731';
    config.OPENROUTER_FALLBACK_MODEL = 'openrouter/free';
    config.ANYMODEL_MODEL = 'am/glm-5.2';
    const chain = _internals.getTextLLMChain();
    assert.deepStrictEqual(chain.map((x) => x.label), [
      'openrouter:deepseek/deepseek-v4-flash-0731',
      'deepseek:deepseek-v4-flash',
      'anymodel:am/glm-5.2',
      'openrouter:openrouter/free',
    ]);
  } finally {
    Object.assign(config, saved);
  }
});

test('цепочка без AnyModel-ключа: OpenRouter → DeepSeek → openrouter/free', () => {
  const { _internals } = require('../src/agent/agent');
  const saved = {
    DEEPSEEK_API_KEY: config.DEEPSEEK_API_KEY,
    OPENROUTER_API_KEY: config.OPENROUTER_API_KEY,
    ANYMODEL_API_KEY: config.ANYMODEL_API_KEY,
    DEEPSEEK_MODEL: config.DEEPSEEK_MODEL,
    OPENROUTER_MODEL: config.OPENROUTER_MODEL,
    OPENROUTER_FALLBACK_MODEL: config.OPENROUTER_FALLBACK_MODEL,
  };
  try {
    config.DEEPSEEK_API_KEY = 'ds';
    config.OPENROUTER_API_KEY = 'or';
    config.ANYMODEL_API_KEY = '';
    config.DEEPSEEK_MODEL = 'deepseek-v4-flash';
    config.OPENROUTER_MODEL = 'deepseek/deepseek-v4-flash-0731';
    config.OPENROUTER_FALLBACK_MODEL = 'openrouter/free';
    const chain = _internals.getTextLLMChain();
    assert.deepStrictEqual(chain.map((x) => x.label), [
      'openrouter:deepseek/deepseek-v4-flash-0731',
      'deepseek:deepseek-v4-flash',
      'openrouter:openrouter/free',
    ]);
  } finally {
    Object.assign(config, saved);
  }
});

test('цепочка с AnyModel без OpenRouter-ключа: DeepSeek → AnyModel', () => {
  const { _internals } = require('../src/agent/agent');
  const saved = {
    DEEPSEEK_API_KEY: config.DEEPSEEK_API_KEY,
    OPENROUTER_API_KEY: config.OPENROUTER_API_KEY,
    ANYMODEL_API_KEY: config.ANYMODEL_API_KEY,
    DEEPSEEK_MODEL: config.DEEPSEEK_MODEL,
    ANYMODEL_MODEL: config.ANYMODEL_MODEL,
  };
  try {
    config.DEEPSEEK_API_KEY = 'ds';
    config.OPENROUTER_API_KEY = '';
    config.ANYMODEL_API_KEY = 'am';
    config.DEEPSEEK_MODEL = 'deepseek-v4-flash';
    config.ANYMODEL_MODEL = 'am/glm-5.2';
    const chain = _internals.getTextLLMChain();
    assert.deepStrictEqual(chain.map((x) => x.label), [
      'deepseek:deepseek-v4-flash',
      'anymodel:am/glm-5.2',
    ]);
  } finally {
    Object.assign(config, saved);
  }
});

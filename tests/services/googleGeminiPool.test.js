'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { GoogleGeminiPool, _internals } = require('../../src/services/googleGeminiPool');

function apiError(status, message = `HTTP ${status}`, headers = null) {
  const error = new Error(message);
  error.status = status;
  error.headers = headers;
  return error;
}

function poolWithHandlers(handlers, options = {}) {
  const calls = [];
  const clients = new Map();
  const pool = new GoogleGeminiPool({
    keys: Object.keys(handlers),
    now: options.now,
    quotaCooldownMs: options.quotaCooldownMs || 1000,
    logger: { warn: () => {} },
    createClient: (key) => {
      const client = {
        chat: { completions: { create: async (params) => {
          calls.push({ key, params });
          return handlers[key](params);
        } } },
      };
      clients.set(key, client);
      return client;
    },
  });
  return { pool, calls, clients };
}

test('round-robin равномерно распределяет успешные запросы между ключами', async () => {
  const handlers = {
    k1: async () => ({ choices: [{ message: { content: 'k1' } }] }),
    k2: async () => ({ choices: [{ message: { content: 'k2' } }] }),
    k3: async () => ({ choices: [{ message: { content: 'k3' } }] }),
  };
  const { pool, calls } = poolWithHandlers(handlers);

  await pool.create({ model: 'gemini-test' });
  await pool.create({ model: 'gemini-test' });
  await pool.create({ model: 'gemini-test' });

  assert.deepEqual(calls.map((call) => call.key), ['k1', 'k2', 'k3']);
  assert.equal(pool.stats().successes, 3);
});

test('429 отправляет ключ на cooldown и тот же запрос обслуживает следующий ключ', async () => {
  let now = 10_000;
  const handlers = {
    k1: async () => { throw apiError(429); },
    k2: async () => ({ choices: [{ message: { content: 'ok' } }] }),
  };
  const { pool, calls } = poolWithHandlers(handlers, { now: () => now, quotaCooldownMs: 5000 });

  const response = await pool.create({ model: 'gemini-test' });

  assert.equal(response.choices[0].message.content, 'ok');
  assert.deepEqual(calls.map((call) => call.key), ['k1', 'k2']);
  assert.equal(pool.stats().available, 1);
  assert.equal(pool.stats().slots[0].cooldown_ms, 5000);

  now += 5001;
  assert.equal(pool.stats().available, 2);
});

test('Retry-After длиннее базового cooldown и учитывается', () => {
  const headers = { get: (name) => name === 'retry-after' ? '12' : null };
  const failure = _internals.classifyFailure(apiError(429, 'quota', headers), 1, 1000);
  assert.equal(failure.cooldownMs, 12_000);
});

test('400 не перебирает остальные ключи и запрещает внешний retry', async () => {
  const handlers = {
    k1: async () => { throw apiError(400, 'invalid tool schema'); },
    k2: async () => ({ choices: [{ message: { content: 'wrong' } }] }),
  };
  const { pool, calls } = poolWithHandlers(handlers);

  await assert.rejects(
    () => pool.create({ model: 'gemini-test' }),
    (error) => error.status === 400 && error.retryable === false
  );
  assert.deepEqual(calls.map((call) => call.key), ['k1']);
});

test('если квота закончилась на всех ключах, пул завершается без раскрытия ключей', async () => {
  const handlers = {
    'secret-one': async () => { throw apiError(429); },
    'secret-two': async () => { throw apiError(429); },
  };
  const { pool } = poolWithHandlers(handlers);

  await assert.rejects(
    () => pool.create({ model: 'gemini-test' }),
    (error) => error.googleGeminiPoolExhausted === true && error.retryable === false
  );
  const serialized = JSON.stringify(pool.stats());
  assert.doesNotMatch(serialized, /secret-one|secret-two/);
  assert.equal(pool.stats().exhausted, 1);
});

test('пустые и повторяющиеся ключи отбрасываются', () => {
  assert.deepEqual(_internals.uniqueKeys(['k1', '', ' k1 ', null, 'k2']), ['k1', 'k2']);
});

test('embedding-вызовы используют ту же безопасную ротацию ключей', async () => {
  const calls = [];
  const pool = new GoogleGeminiPool({
    keys: ['k1', 'k2'],
    createClient: (key) => ({
      embeddings: {
        create: async (params) => {
          calls.push({ key, model: params.model });
          return { data: [{ embedding: [1, 0] }] };
        },
      },
    }),
    logger: { warn() {} },
  });

  await pool.createEmbedding({ model: 'gemini-embedding-001', input: 'one' });
  await pool.createEmbedding({ model: 'gemini-embedding-001', input: 'two' });

  assert.deepEqual(calls.map((call) => call.key), ['k1', 'k2']);
});

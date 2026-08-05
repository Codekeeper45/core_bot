'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { LlmCircuitBreaker, _internals } = require('../../src/services/llmCircuitBreaker');

function apiError(status, message = `HTTP ${status}`, retryAfter = null) {
  const error = new Error(message);
  error.status = status;
  if (retryAfter != null) error.headers = { get: () => String(retryAfter) };
  return error;
}

function fakeClock(start = 1000) {
  let now = start;
  const timers = [];
  return {
    now: () => now,
    advance: (ms) => { now += ms; },
    timers,
    setTimer: (fn, delay) => {
      const timer = { fn, delay, cleared: false, unref() {} };
      timers.push(timer);
      return timer;
    },
    clearTimer: (timer) => { timer.cleared = true; },
  };
}

function route(label = 'provider:model') {
  return { label, provider: label.split(':')[0], tier: 'fallback', model: 'model', client: {} };
}

test('402 и 429 получают разные cooldown по типу ошибки', () => {
  const balance = _internals.classifyCircuitError(apiError(402, 'Insufficient Balance'));
  const limited = _internals.classifyCircuitError(apiError(429, 'rate limit', 90));

  assert.equal(balance.type, 'balance');
  assert.equal(balance.cooldownMs, 15 * 60 * 1000);
  assert.equal(limited.type, 'rate_limit');
  assert.equal(limited.cooldownMs, 90 * 1000);
});

test('открытый circuit сразу исключает маршрут из следующих запросов', () => {
  const clock = fakeClock();
  const breaker = new LlmCircuitBreaker({
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    logger: { info() {}, warn() {} },
  });
  const dead = route('openrouter:paid-model');
  const healthy = route('google:free-model');
  breaker.recordAttempt(dead);
  breaker.recordFailure(dead, apiError(402, 'Insufficient Balance'), async () => {});

  assert.deepEqual(breaker.available([dead, healthy]).map((item) => item.label), ['google:free-model']);
  assert.equal(breaker.stats().find((item) => item.route === dead.label).status, 'open');
  assert.equal(clock.timers.length, 1);
});

test('успешная фоновая проба автоматически возвращает маршрут', async () => {
  const clock = fakeClock();
  const breaker = new LlmCircuitBreaker({
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    logger: { info() {}, warn() {} },
    durations: { unavailableMs: 1000 },
  });
  const candidate = route('anymodel:glm');
  let probes = 0;
  breaker.recordFailure(candidate, apiError(503), async () => { probes++; });

  assert.equal(clock.timers[0].delay, 1000);
  clock.advance(1000);
  await clock.timers[0].fn();

  assert.equal(probes, 1);
  assert.equal(breaker.available([candidate]).length, 1);
  const stats = breaker.stats()[0];
  assert.equal(stats.status, 'closed');
  assert.equal(stats.probes, 1);
  assert.equal(stats.recoveries, 1);
});

test('после cooldown обычный запрос не обгоняет фоновую проверку', async () => {
  const clock = fakeClock();
  const breaker = new LlmCircuitBreaker({
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    logger: { info() {}, warn() {} },
    durations: { unavailableMs: 1000 },
  });
  const candidate = route('provider:slow');
  breaker.recordFailure(candidate, apiError(503), async () => {});

  clock.advance(1000);
  assert.equal(breaker.available([candidate]).length, 0);
  await clock.timers[0].fn();
  assert.equal(breaker.available([candidate]).length, 1);
});

test('повторный сетевой сбой увеличивает время заморозки', () => {
  const first = _internals.classifyCircuitError(new Error('network timeout'), 1);
  const third = _internals.classifyCircuitError(new Error('network timeout'), 3);
  assert.equal(first.cooldownMs, 30_000);
  assert.equal(third.cooldownMs, 120_000);
});

test('статистика circuit не содержит клиентов или секретов', () => {
  const breaker = new LlmCircuitBreaker({ logger: { info() {}, warn() {} } });
  const candidate = { ...route('google:gemini'), client: { apiKey: 'secret-key' } };
  breaker.recordAttempt(candidate);
  breaker.recordSuccess(candidate, 250);

  const serialized = JSON.stringify(breaker.stats());
  assert.doesNotMatch(serialized, /secret-key|apiKey|client/);
  assert.match(serialized, /latency_ewma_ms/);
});

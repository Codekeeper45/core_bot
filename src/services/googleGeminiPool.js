'use strict';

const OpenAI = require('openai');
const config = require('../config');

const AUTH_COOLDOWN_MS = 60 * 60 * 1000;
const MAX_QUOTA_COOLDOWN_MS = 15 * 60 * 1000;

function uniqueKeys(keys) {
  return [...new Set((keys || []).map((key) => String(key || '').trim()).filter(Boolean))];
}

function errorStatus(error) {
  const direct = Number(error && (error.status || error.statusCode));
  if (Number.isFinite(direct) && direct > 0) return direct;
  const match = String(error && error.message || '').match(/\b(4\d\d|5\d\d)\b/);
  return match ? Number(match[1]) : 0;
}

function retryAfterMs(error) {
  const headers = error && error.headers;
  const raw = headers && typeof headers.get === 'function'
    ? headers.get('retry-after')
    : headers && (headers['retry-after'] || headers['Retry-After']);
  const seconds = Number(raw);
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 0;
}

function classifyFailure(error, failureCount, baseCooldownMs) {
  const status = errorStatus(error);
  if (status === 401 || status === 402 || status === 403) {
    return { rotate: true, retryable: false, cooldownMs: AUTH_COOLDOWN_MS, status };
  }
  if (status === 429) {
    const backoff = Math.min(baseCooldownMs * (2 ** Math.max(0, failureCount - 1)), MAX_QUOTA_COOLDOWN_MS);
    return { rotate: true, retryable: false, cooldownMs: Math.max(retryAfterMs(error), backoff), status };
  }
  if (status === 408 || status >= 500 || /timeout|etimedout|econnreset|network|fetch failed/i.test(String(error && error.message || ''))) {
    return { rotate: false, retryable: true, cooldownMs: Math.min(baseCooldownMs, 30_000), status };
  }
  return { rotate: false, retryable: false, cooldownMs: 0, status };
}

class GoogleGeminiPool {
  constructor({ keys, baseURL, createClient, now, logger, quotaCooldownMs, timeoutMs } = {}) {
    const cleanKeys = uniqueKeys(keys);
    this.baseURL = baseURL || 'https://generativelanguage.googleapis.com/v1beta/openai/';
    this.timeoutMs = Math.max(1000, Number(timeoutMs) || 60_000);
    this.createClient = createClient || ((key) => new OpenAI({
      apiKey: key,
      baseURL: this.baseURL,
      maxRetries: 0,
      timeout: this.timeoutMs,
    }));
    this.now = now || (() => Date.now());
    this.logger = logger || console;
    this.quotaCooldownMs = Math.max(1000, Number(quotaCooldownMs) || 60_000);
    this.cursor = 0;
    this.metrics = { requests: 0, successes: 0, failovers: 0, exhausted: 0 };
    this.states = cleanKeys.map((key, index) => ({
      key,
      slot: index + 1,
      client: this.createClient(key),
      cooldownUntil: 0,
      calls: 0,
      successes: 0,
      failures: 0,
      lastStatus: 0,
    }));
  }

  nextAvailable(excluded) {
    if (!this.states.length) return null;
    const now = this.now();
    for (let offset = 0; offset < this.states.length; offset++) {
      const index = (this.cursor + offset) % this.states.length;
      const state = this.states[index];
      if (!excluded.has(index) && state.cooldownUntil <= now) {
        this.cursor = (index + 1) % this.states.length;
        return { state, index };
      }
    }
    return null;
  }

  async execute(operation) {
    if (!this.states.length) {
      const error = new Error('Google Gemini provider is not configured');
      error.retryable = false;
      throw error;
    }

    this.metrics.requests++;
    const attempted = new Set();
    let lastError = null;

    while (attempted.size < this.states.length) {
      const selected = this.nextAvailable(attempted);
      if (!selected) break;
      const { state, index } = selected;
      attempted.add(index);
      state.calls++;

      try {
        const response = await operation(state.client, state.key);
        state.successes++;
        state.failures = 0;
        state.lastStatus = 0;
        state.cooldownUntil = 0;
        this.metrics.successes++;
        return response;
      } catch (error) {
        lastError = error;
        state.failures++;
        const failure = classifyFailure(error, state.failures, this.quotaCooldownMs);
        state.lastStatus = failure.status;
        if (failure.cooldownMs > 0) state.cooldownUntil = this.now() + failure.cooldownMs;

        if (!failure.rotate) {
          error.retryable = failure.retryable;
          throw error;
        }

        this.metrics.failovers++;
        this.logger.warn(`[GoogleGemini] key slot ${state.slot} unavailable (${failure.status || 'error'}); rotating`);
      }
    }

    this.metrics.exhausted++;
    const error = lastError || new Error('All Google Gemini keys are cooling down');
    error.retryable = false;
    error.googleGeminiPoolExhausted = true;
    throw error;
  }

  async create(params) {
    return this.execute((client) => client.chat.completions.create(params));
  }

  async createEmbedding(params) {
    return this.execute((client) => client.embeddings.create(params));
  }

  getClient() {
    return {
      chat: {
        completions: {
          create: (params) => this.create(params),
        },
      },
      embeddings: {
        create: (params) => this.createEmbedding(params),
      },
    };
  }

  stats() {
    const now = this.now();
    return {
      ...this.metrics,
      keys: this.states.length,
      available: this.states.filter((state) => state.cooldownUntil <= now).length,
      slots: this.states.map((state) => ({
        slot: state.slot,
        calls: state.calls,
        successes: state.successes,
        failures: state.failures,
        last_status: state.lastStatus || null,
        cooldown_ms: Math.max(0, state.cooldownUntil - now),
      })),
    };
  }
}

let defaultPool = null;
let defaultSignature = '';

function configuredKeys() {
  return uniqueKeys([
    ...(config.GOOGLE_GEMINI_API_KEYS || []),
    config.GOOGLE_GEMINI_API_KEY,
  ]);
}

function hasGoogleGeminiKeys() {
  return configuredKeys().length > 0;
}

function getGoogleGeminiPool() {
  const keys = configuredKeys();
  const signature = JSON.stringify([
    keys,
    config.GOOGLE_GEMINI_BASE_URL,
    config.GOOGLE_GEMINI_QUOTA_COOLDOWN_MS,
    config.GOOGLE_GEMINI_TIMEOUT_MS,
  ]);
  if (!defaultPool || signature !== defaultSignature) {
    defaultSignature = signature;
    defaultPool = new GoogleGeminiPool({
      keys,
      baseURL: config.GOOGLE_GEMINI_BASE_URL,
      quotaCooldownMs: config.GOOGLE_GEMINI_QUOTA_COOLDOWN_MS,
      timeoutMs: config.GOOGLE_GEMINI_TIMEOUT_MS,
    });
  }
  return defaultPool;
}

function getGoogleGeminiClient() {
  return getGoogleGeminiPool().getClient();
}

module.exports = {
  GoogleGeminiPool,
  getGoogleGeminiClient,
  getGoogleGeminiPool,
  hasGoogleGeminiKeys,
  _internals: { uniqueKeys, errorStatus, retryAfterMs, classifyFailure },
};

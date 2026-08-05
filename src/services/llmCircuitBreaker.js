'use strict';

const DEFAULTS = {
  balanceMs: 15 * 60 * 1000,
  authMs: 30 * 60 * 1000,
  rateLimitMs: 60 * 1000,
  unavailableMs: 30 * 1000,
  invalidModelMs: 10 * 60 * 1000,
  invalidRequestMs: 2 * 60 * 1000,
  unknownMs: 60 * 1000,
  maxUnavailableMs: 5 * 60 * 1000,
};

function statusOf(error) {
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

function classifyCircuitError(error, consecutiveFailures = 1, durations = DEFAULTS) {
  const status = statusOf(error);
  const message = String(error && error.message || '').toLowerCase();
  if (status === 401 || /invalid api key|authentication/.test(message)) {
    return { type: 'auth', status, cooldownMs: durations.authMs };
  }
  if (status === 402 || /insufficient balance|more credits|can only afford/.test(message)) {
    return { type: 'balance', status, cooldownMs: durations.balanceMs };
  }
  if (status === 403) return { type: 'forbidden', status, cooldownMs: durations.authMs };
  if (status === 429 || /rate.?limit|too many requests|quota/.test(message)) {
    return { type: 'rate_limit', status, cooldownMs: Math.max(durations.rateLimitMs, retryAfterMs(error)) };
  }
  if (/no endpoints|model.*not found|unsupported model|does not support tools/.test(message) || status === 404) {
    return { type: 'model_unavailable', status, cooldownMs: durations.invalidModelMs };
  }
  if (status === 400 || status === 422 || /invalid request|invalid tool|malformed/.test(message)) {
    return { type: 'request_rejected', status, cooldownMs: durations.invalidRequestMs };
  }
  if (status === 408 || status >= 500 || /timeout|etimedout|econnreset|econnrefused|enotfound|network|socket|fetch failed/.test(message)) {
    const multiplier = 2 ** Math.max(0, consecutiveFailures - 1);
    return {
      type: 'unavailable',
      status,
      cooldownMs: Math.min(durations.unavailableMs * multiplier, durations.maxUnavailableMs),
    };
  }
  return { type: 'unknown', status, cooldownMs: durations.unknownMs };
}

class LlmCircuitBreaker {
  constructor({ now, setTimer, clearTimer, logger, durations } = {}) {
    this.now = now || (() => Date.now());
    this.setTimer = setTimer || setTimeout;
    this.clearTimer = clearTimer || clearTimeout;
    this.logger = logger || console;
    this.durations = { ...DEFAULTS, ...(durations || {}) };
    this.states = new Map();
  }

  ensure(route) {
    let state = this.states.get(route.label);
    if (!state) {
      state = {
        label: route.label,
        provider: route.provider,
        tier: route.tier,
        status: 'closed',
        openUntil: 0,
        consecutiveFailures: 0,
        attempts: 0,
        successes: 0,
        failures: 0,
        probes: 0,
        recoveries: 0,
        latencyEwmaMs: null,
        lastErrorType: null,
        lastStatus: null,
        probing: false,
        timer: null,
        route,
      };
      this.states.set(route.label, state);
    } else {
      state.route = route;
      state.provider = route.provider;
      state.tier = route.tier;
    }
    return state;
  }

  canAttempt(route) {
    const state = this.ensure(route);
    // Re-entry is owned by the scheduled background probe. Regular requests
    // never race a half-open provider and therefore never pay its recovery delay.
    return state.status === 'closed';
  }

  available(routes) {
    return (routes || []).filter((route) => this.canAttempt(route));
  }

  recordAttempt(route) {
    const state = this.ensure(route);
    state.attempts++;
    return state;
  }

  recordSuccess(route, latencyMs, { probe = false } = {}) {
    const state = this.ensure(route);
    const wasOpen = state.status !== 'closed';
    state.status = 'closed';
    state.openUntil = 0;
    state.consecutiveFailures = 0;
    state.successes++;
    state.lastErrorType = null;
    state.lastStatus = null;
    state.probing = false;
    if (Number.isFinite(latencyMs)) {
      state.latencyEwmaMs = state.latencyEwmaMs == null
        ? Math.round(latencyMs)
        : Math.round((state.latencyEwmaMs * 0.8) + (latencyMs * 0.2));
    }
    if (state.timer) {
      this.clearTimer(state.timer);
      state.timer = null;
    }
    if (probe && wasOpen) {
      state.recoveries++;
      this.logger.info(`[Agent] LLM route ${route.label} recovered in background`);
    }
  }

  recordFailure(route, error, probeFn) {
    const state = this.ensure(route);
    state.failures++;
    state.consecutiveFailures++;
    const failure = classifyCircuitError(error, state.consecutiveFailures, this.durations);
    state.status = 'open';
    state.openUntil = this.now() + failure.cooldownMs;
    state.lastErrorType = failure.type;
    state.lastStatus = failure.status || null;
    state.probing = false;
    this.scheduleProbe(state, probeFn);
    return failure;
  }

  scheduleProbe(state, probeFn) {
    if (typeof probeFn !== 'function') return;
    if (state.timer) this.clearTimer(state.timer);
    const delay = Math.max(0, state.openUntil - this.now());
    state.timer = this.setTimer(async () => {
      state.timer = null;
      if (state.probing || state.status === 'closed') return;
      state.probing = true;
      state.status = 'half_open';
      state.probes++;
      const started = this.now();
      try {
        await probeFn(state.route);
        this.recordSuccess(state.route, this.now() - started, { probe: true });
      } catch (error) {
        this.recordFailure(state.route, error, probeFn);
      }
    }, delay);
    if (state.timer && typeof state.timer.unref === 'function') state.timer.unref();
  }

  stats() {
    const now = this.now();
    return [...this.states.values()].map((state) => ({
      route: state.label,
      provider: state.provider,
      tier: state.tier,
      status: state.status,
      cooldown_ms: Math.max(0, state.openUntil - now),
      attempts: state.attempts,
      successes: state.successes,
      failures: state.failures,
      probes: state.probes,
      recoveries: state.recoveries,
      reliability: Number(((state.successes + 1) / (state.attempts + 2)).toFixed(3)),
      latency_ewma_ms: state.latencyEwmaMs,
      last_error_type: state.lastErrorType,
      last_status: state.lastStatus,
    }));
  }

  reset() {
    for (const state of this.states.values()) {
      if (state.timer) this.clearTimer(state.timer);
    }
    this.states.clear();
  }
}

module.exports = {
  LlmCircuitBreaker,
  _internals: { DEFAULTS, statusOf, retryAfterMs, classifyCircuitError },
};

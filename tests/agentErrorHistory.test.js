'use strict';
// A3: история агента обязана сохраняться и на аварийных путях выхода —
// инструменты предыдущих итераций могли уже выполниться (БД изменена,
// сообщения отправлены), потеря хода ведёт к дублям действий.
const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');

const saved = [];
const origRequire = Module.prototype.require;
Module.prototype.require = function (id) {
  if (id === './memory') {
    return {
      loadChatHistory: async () => ({ messages: [], summary: '' }),
      saveChatHistory: async (channel, chatId, messages, summary) => { saved.push({ channel, chatId, messages, summary }); },
    };
  }
  if (id === './systemPrompt') {
    return { getSystemPrompt: async () => 'test system prompt' };
  }
  if (id === '../services/mysql') {
    return {
      archiveMessage: async () => {},
      logBotEvent: async () => {},
    };
  }
  if (id === '../services/notifier') {
    return { alertManager: async () => false };
  }
  if (id === '../services/developerFeedback') {
    return { reportDeveloperError: async () => ({ ok: true }) };
  }
  return origRequire.apply(this, arguments);
};
after(() => { Module.prototype.require = origRequire; });

describe('dropDanglingToolTail', () => {
  const { _internals } = require('../src/agent/agent');
  const drop = _internals.dropDanglingToolTail;

  test('полный блок tool_calls + все результаты — не трогаем', () => {
    const msgs = [
      { role: 'user', content: 'привет' },
      { role: 'assistant', tool_calls: [{ id: 'a' }, { id: 'b' }] },
      { role: 'tool', tool_call_id: 'a', content: '{}' },
      { role: 'tool', tool_call_id: 'b', content: '{}' },
    ];
    assert.deepEqual(drop(msgs), msgs);
  });

  test('assistant с tool_calls без результата — блок срезается целиком', () => {
    const msgs = [
      { role: 'user', content: 'привет' },
      { role: 'assistant', tool_calls: [{ id: 'a' }, { id: 'b' }] },
      { role: 'tool', tool_call_id: 'a', content: '{}' }, // 'b' не пришёл
    ];
    assert.deepEqual(drop(msgs), msgs.slice(0, 1));
  });

  test('обычный хвост (assistant без tool_calls / user) — не трогаем', () => {
    const msgs = [{ role: 'user', content: 'q' }, { role: 'assistant', content: 'a' }];
    assert.deepEqual(drop(msgs), msgs);
    assert.deepEqual(drop([{ role: 'user', content: 'q' }]), [{ role: 'user', content: 'q' }]);
    assert.deepEqual(drop([]), []);
  });
});

describe('classifyLlmError — честные сообщения по сути ошибки', () => {
  const { _internals } = require('../src/agent/agent');
  const c = _internals.classifyLlmError;

  test('402/баланс → про средства; 429 → про лимит', () => {
    assert.equal(c('402 This request requires more credits, or fewer max_tokens'), _internals.FALLBACK_NO_CREDITS);
    assert.equal(c('can only afford 100 tokens'), _internals.FALLBACK_NO_CREDITS);
    assert.equal(c('429 rate limit exceeded'), _internals.FALLBACK_RATE_LIMIT);
  });

  test('400/нет endpoints → модель отклонила; пустой ответ → модель пустая', () => {
    assert.equal(c('400 Provider returned error'), _internals.FALLBACK_MODEL_REJECTED);
    assert.equal(c('no endpoints found for model'), _internals.FALLBACK_MODEL_REJECTED);
    assert.equal(c('провайдер вернул некорректный ответ (ответ без choices)'), _internals.FALLBACK_MODEL_EMPTY);
  });

  test('сеть/таймаут → про связь; нет провайдера; иначе общий', () => {
    assert.equal(c('connect ETIMEDOUT'), _internals.FALLBACK_NETWORK);
    assert.equal(c('No LLM provider configured (set DEEPSEEK_API_KEY or OPENROUTER_API_KEY)'), _internals.FALLBACK_NO_PROVIDER);
    assert.equal(c('какая-то неведомая ошибка'), _internals.FALLBACK_LLM_GENERIC);
  });

  test('все сообщения распознаются как аварийные (FALLBACK_MESSAGES)', () => {
    assert.ok(_internals.FALLBACK_MESSAGES.has(_internals.FALLBACK_NO_CREDITS));
    assert.ok(_internals.FALLBACK_MESSAGES.has(_internals.FALLBACK_INTERNAL));
    assert.ok(!_internals.FALLBACK_MESSAGES.has('обычный ответ бота'));
  });
});

describe('runAgent: llm_error сохраняет историю', () => {
  test('все провайдеры недоступны → user + fallback-assistant записаны в историю', async () => {
    saved.length = 0;
    delete require.cache[require.resolve('../src/agent/agent')];
    const { runAgent, _internals } = require('../src/agent/agent');

    // Пустая цепочка провайдеров → llmCreateWithFallback бросает → путь llm_error.
    const config = require('../src/config');
    const savedKeys = { ds: config.DEEPSEEK_API_KEY, or: config.OPENROUTER_API_KEY };
    config.DEEPSEEK_API_KEY = '';
    config.OPENROUTER_API_KEY = '';
    try {
      const reply = await runAgent({
        combinedMessage: 'тестовое сообщение',
        channel: 'telegram', chatId: '42', phone: '7777', clientName: 'Босс', role: 'boss',
      });
      // Нет ключей → «No LLM provider configured» → честное сообщение про провайдера.
      assert.equal(reply, _internals.FALLBACK_NO_PROVIDER);
      assert.equal(saved.length, 1);
      const msgs = saved[0].messages;
      assert.equal(msgs[msgs.length - 2].role, 'user');
      assert.match(msgs[msgs.length - 2].content, /тестовое сообщение/);
      assert.equal(msgs[msgs.length - 1].role, 'assistant');
      assert.equal(msgs[msgs.length - 1].content, _internals.FALLBACK_NO_PROVIDER);
    } finally {
      config.DEEPSEEK_API_KEY = savedKeys.ds;
      config.OPENROUTER_API_KEY = savedKeys.or;
      delete require.cache[require.resolve('../src/agent/agent')];
    }
  });
});

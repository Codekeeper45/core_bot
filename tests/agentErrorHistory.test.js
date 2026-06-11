'use strict';
// A3: история агента обязана сохраняться и на аварийных путях выхода —
// инструменты предыдущих итераций могли уже выполниться (БД изменена,
// сообщения отправлены), потеря хода ведёт к дублям действий.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

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

describe('runAgent: llm_error сохраняет историю', () => {
  test('все провайдеры недоступны → user + fallback-assistant записаны в историю', async () => {
    const Module = require('module');
    const orig = Module.prototype.require;
    const saved = [];
    Module.prototype.require = function (id) {
      if (id === './memory') {
        return {
          loadChatHistory: async () => ({ messages: [], summary: '' }),
          saveChatHistory: async (channel, chatId, messages, summary) => { saved.push({ channel, chatId, messages, summary }); },
        };
      }
      return orig.apply(this, arguments);
    };
    delete require.cache[require.resolve('../src/agent/agent')];
    const { runAgent, _internals } = require('../src/agent/agent');
    Module.prototype.require = orig;

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
      assert.equal(reply, _internals.FALLBACK_BUSY);
      assert.equal(saved.length, 1);
      const msgs = saved[0].messages;
      assert.equal(msgs[msgs.length - 2].role, 'user');
      assert.match(msgs[msgs.length - 2].content, /тестовое сообщение/);
      assert.equal(msgs[msgs.length - 1].role, 'assistant');
      assert.equal(msgs[msgs.length - 1].content, _internals.FALLBACK_BUSY);
    } finally {
      config.DEEPSEEK_API_KEY = savedKeys.ds;
      config.OPENROUTER_API_KEY = savedKeys.or;
      delete require.cache[require.resolve('../src/agent/agent')];
    }
  });
});

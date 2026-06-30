'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { _internals } = require('../src/agent/agent');
const { capToolCall } = _internals;

describe('capToolCall: потолок вызовов за прогон', () => {
  test('web_search до лимита проходит, сверх — отклоняется', () => {
    const counts = {};
    const limits = { web_search: 10 };
    for (let i = 1; i <= 10; i++) {
      assert.equal(capToolCall('web_search', counts, limits).capped, false, `вызов ${i}`);
    }
    const over = capToolCall('web_search', counts, limits); // 11-й
    assert.equal(over.capped, true);
    assert.equal(over.result.success, false);
    assert.match(over.result.note, /Лимит|исчерпан/i);
  });

  test('инструменты без лимита не капаются', () => {
    const counts = {};
    for (let i = 0; i < 50; i++) {
      assert.equal(capToolCall('message_employee', counts, { web_search: 10 }).capped, false);
    }
  });
});

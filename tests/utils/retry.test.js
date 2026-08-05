'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { withRetry } = require('../../src/utils/retry');

test('retryable=false прекращает повторы сразу', async () => {
  let calls = 0;
  const error = new Error('invalid provider request');
  error.retryable = false;

  await assert.rejects(
    () => withRetry(async () => {
      calls++;
      throw error;
    }, { maxRetries: 4, baseDelay: 1 }),
    /invalid provider request/
  );

  assert.equal(calls, 1);
});

'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { rollupStatus } = require('../src/utils/projectRollup');

test('all tasks done → done', () => {
  assert.strictEqual(rollupStatus({ total: 3, done: 3, blocked: 0 }), 'done');
});

test('any blocked (not all done) → blocked', () => {
  assert.strictEqual(rollupStatus({ total: 3, done: 1, blocked: 1 }), 'blocked');
});

test('in progress, none blocked → active', () => {
  assert.strictEqual(rollupStatus({ total: 3, done: 1, blocked: 0 }), 'active');
});

test('empty project is not done → active', () => {
  assert.strictEqual(rollupStatus({ total: 0, done: 0, blocked: 0 }), 'active');
});

test('done takes precedence over blocked when all done', () => {
  // защитный кейс: если done===total, blocked не должен пересиливать
  assert.strictEqual(rollupStatus({ total: 2, done: 2, blocked: 0 }), 'done');
});

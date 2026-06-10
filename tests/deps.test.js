'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { parseDeps, unmetDeps } = require('../src/utils/deps');

test('parseDeps parses CSV of ids, ignoring junk', () => {
  assert.deepStrictEqual(parseDeps('1, 2 ,3'), [1, 2, 3]);
  assert.deepStrictEqual(parseDeps(''), []);
  assert.deepStrictEqual(parseDeps(null), []);
  assert.deepStrictEqual(parseDeps('1,abc,4'), [1, 4]);
});

test('unmetDeps returns predecessors that are not done', () => {
  const siblings = [
    { id: 1, status: 'done' },
    { id: 2, status: 'in_progress' },
    { id: 3, status: 'todo' },
  ];
  const task = { id: 4, depends_on: '1,2,3' };
  assert.deepStrictEqual(unmetDeps(task, siblings), [2, 3]);
});

test('unmetDeps empty when all deps done', () => {
  const siblings = [{ id: 1, status: 'done' }, { id: 2, status: 'done' }];
  assert.deepStrictEqual(unmetDeps({ id: 3, depends_on: '1,2' }, siblings), []);
});

test('unmetDeps empty when no deps', () => {
  assert.deepStrictEqual(unmetDeps({ id: 1, depends_on: '' }, []), []);
  assert.deepStrictEqual(unmetDeps({ id: 1 }, []), []);
});

'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { pruneCycles } = require('../src/utils/dag');

test('acyclic graph is preserved, nothing dropped', () => {
  const { adj, dropped } = pruneCycles([
    ['t1', []],
    ['t2', ['t1']],
    ['t3', ['t1', 't2']],
  ]);
  assert.deepStrictEqual(dropped, []);
  assert.deepStrictEqual(adj.get('t2'), ['t1']);
  assert.deepStrictEqual(adj.get('t3'), ['t1', 't2']);
});

test('direct cycle t1->t2->t1 drops the back-edge', () => {
  const { dropped } = pruneCycles([
    ['t1', ['t2']],
    ['t2', ['t1']],
  ]);
  assert.strictEqual(dropped.length, 1);
});

test('longer cycle is broken into a valid DAG', () => {
  const { adj, dropped } = pruneCycles([
    ['a', ['b']],
    ['b', ['c']],
    ['c', ['a']],
  ]);
  assert.strictEqual(dropped.length, 1);
  // After pruning, no node should still close the cycle: total kept edges = 2
  let kept = 0;
  for (const tos of adj.values()) kept += tos.length;
  assert.strictEqual(kept, 2);
});

test('self-handling: duplicate edges deduped', () => {
  const { adj } = pruneCycles([['x', ['y', 'y']], ['y', []]]);
  assert.deepStrictEqual(adj.get('x'), ['y']);
});

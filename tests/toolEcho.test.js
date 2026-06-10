'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { formatToolEcho } = require('../src/utils/toolEcho');

test('create_project echo shows title and task count (as «план»)', () => {
  const out = formatToolEcho('create_project', { title: 'Лендинг', tasks: [1, 2, 3] });
  assert.match(out, /Составляю план/);
  assert.match(out, /Лендинг/);
  assert.match(out, /3 задач/);
});

test('dispatch_task and update_task echo include task id', () => {
  assert.match(formatToolEcho('dispatch_task', { task_id: 7 }), /#7/);
  assert.match(formatToolEcho('update_task', { task_id: 7, status: 'done' }), /#7.*done/);
});

test('project_status differs with/without id', () => {
  assert.match(formatToolEcho('project_status', { project_id: 5 }), /#5/);
  assert.match(formatToolEcho('project_status', {}), /список планов/);
});

test('unknown tool falls back to generic line', () => {
  assert.match(formatToolEcho('something_new', {}), /something_new/);
});

test('never throws on missing args', () => {
  assert.doesNotThrow(() => formatToolEcho('dispatch_task'));
  assert.doesNotThrow(() => formatToolEcho('create_project', { tasks: null }));
});

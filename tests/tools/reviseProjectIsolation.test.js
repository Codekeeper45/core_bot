'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');

const calls = [];
const mysqlMock = {
  getProject: async () => ({ id: 10, title: 'Целевой' }),
  updateProjectPlan: async () => calls.push('plan'),
  createTasksBulk: async () => [],
  assignTask: async () => calls.push('assign'),
  getTask: async () => ({ id: 99, project_id: 20, title: 'Чужая задача' }),
  getEmployeeById: async () => ({ id: 1, name: 'Исполнитель' }),
  updateTaskFields: async () => calls.push('edit'),
  updateTaskStatus: async () => calls.push('cancel'),
  recomputeProjectStatus: async () => calls.push('recompute'),
};

const orig = Module.prototype.require;
Module.prototype.require = function (id) {
  if (id === '../services/mysql') return mysqlMock;
  return orig.apply(this, arguments);
};
delete require.cache[require.resolve('../../src/tools/reviseProject')];
const { handler } = require('../../src/tools/reviseProject');
Module.prototype.require = orig;

test('revise_project не изменяет задачу из другого проекта', async () => {
  calls.length = 0;
  const result = await handler({
    project_id: 10,
    note: 'правка',
    edit_tasks: [{ task_id: 99, title: 'Новое имя' }],
    reassign: [{ task_id: 99, employee_id: 1 }],
    cancel_tasks: [{ task_id: 99, reason: 'не нужна' }],
  });
  assert.equal(result.success, true);
  assert.deepEqual(calls, []);
  assert.equal(result.warnings.length, 3);
  assert.ok(result.warnings.every((w) => /друг(ому|ого) план/i.test(w)));
});

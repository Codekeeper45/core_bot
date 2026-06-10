'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

let employees = [];
let openTasks = [];
const mysqlMock = {
  listEmployees: async () => employees,
  listOpenTasksBrief: async () => openTasks,
};

const Module = require('module');
const originalRequire = Module.prototype.require;
Module.prototype.require = function (id) {
  if (id === '../services/mysql') return mysqlMock;
  return originalRequire.apply(this, arguments);
};
const { handler } = require('../../src/tools/listEmployees');
Module.prototype.require = originalRequire;

describe('list_employees open_tasks', () => {
  test('groups open tasks by assignee with real task ids', async () => {
    employees = [
      { id: 8, name: 'Пак Ирина', roles: 'Главный бухгалтер', contact: '7707', open_task_count: 2 },
      { id: 15, name: 'Сангов', roles: 'Менеджер', contact: '7707', open_task_count: 0 },
    ];
    openTasks = [
      { id: 101, title: 'Сверка', project_id: 5, status: 'in_progress', assignee_id: 8 },
      { id: 102, title: 'Отчёт', project_id: 5, status: 'dispatched', assignee_id: 8 },
      { id: 103, title: 'Без исполнителя', project_id: 6, status: 'todo', assignee_id: null },
    ];
    const r = await handler();
    const irina = r.employees.find((e) => e.id === 8);
    assert.equal(irina.open_tasks.length, 2);
    assert.deepEqual(irina.open_tasks.map((t) => t.id), [101, 102]);
    const sangov = r.employees.find((e) => e.id === 15);
    assert.equal(sangov.open_tasks.length, 0);
    assert.equal(r.unassigned_open_tasks.length, 1);
    assert.equal(r.unassigned_open_tasks[0].id, 103);
  });

  test('caps open_tasks per employee at 10', async () => {
    employees = [{ id: 1, name: 'X', roles: 'r', contact: '7', open_task_count: 15 }];
    openTasks = Array.from({ length: 15 }, (_, i) => ({ id: i + 1, title: 't' + i, project_id: 1, status: 'todo', assignee_id: 1 }));
    const r = await handler();
    assert.equal(r.employees[0].open_tasks.length, 10);
  });
});

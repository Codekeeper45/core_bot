'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');

let saved = null;
const mysqlMock = {
  getTask: async () => ({ id: 12, project_id: 5, assignee_id: 3, title: 'Собрать заказ' }),
  findEmployeeByContact: async () => ({ id: 3, name: 'Али' }),
  createTaskReport: async (id, report) => { saved = { id, report }; return { id, project_id: 5, title: 'Собрать заказ', status: report.status }; },
  recomputeProjectStatus: async () => 'active',
};
const configMock = { BOSS_CONTACTS: [] };
const notifierMock = { notifyOwner: async () => true };
const orig = Module.prototype.require;
Module.prototype.require = function (id) {
  if (id === '../services/mysql') return mysqlMock;
  if (id === '../config') return configMock;
  if (id === '../services/notifier') return notifierMock;
  return orig.apply(this, arguments);
};
const { definition, handler } = require('../../src/tools/taskReport');
Module.prototype.require = orig;

test('task_report требует точный task_id и сохраняет структурированный отчёт', async () => {
  assert.ok(definition.function.parameters.required.includes('task_id'));
  const result = await handler({
    task_id: 12,
    status: 'in_progress',
    comment: 'Собрано 70%',
    progress_percent: 70,
    next_step: 'Упаковать',
  }, { channel: 'whatsapp', chatId: '7700', clientName: 'Али', role: 'employee' });
  assert.equal(result.success, true);
  assert.equal(saved.id, 12);
  assert.equal(saved.report.progress_percent, 70);
});


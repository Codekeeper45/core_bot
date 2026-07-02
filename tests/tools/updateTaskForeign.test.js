'use strict';
// update_task без иерархии: чужую задачу менять МОЖНО, но босс уведомляется.
const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');

let bossNotices = [];
let ownerNotices = [];
const mysqlMock = {
  getTask: async (id) => ({ id, project_id: 5, assignee_id: 3, title: 'Собрать заказ', dispatched: 0, status: 'in_progress' }),
  findEmployeeByContact: async (channel, contact) => (String(contact) === '7700' ? { id: 3, name: 'Али' } : { id: 9, name: 'Берик' }),
  updateTaskStatus: async () => true,
  recomputeProjectStatus: async () => 'active',
  getEmployeeById: async () => ({ id: 3, name: 'Али' }),
};
const configMock = { BOSS_CONTACTS: ['77070009999'] };
const notifierMock = {
  notifyOwner: async (projectId, text) => { ownerNotices.push({ projectId, text }); return true; },
  notifyBossAboutChange: async (context, text, opts) => { bossNotices.push({ context, text, opts }); return true; },
};

const orig = Module.prototype.require;
Module.prototype.require = function (id) {
  if (id === '../services/mysql') return mysqlMock;
  if (id === '../config') return configMock;
  if (id === '../services/notifier') return notifierMock;
  return orig.apply(this, arguments);
};
const { handler } = require('../../src/tools/updateTask');
Module.prototype.require = orig;

const tick = () => new Promise((r) => setImmediate(r));

describe('update_task: чужие задачи и уведомление босса', () => {
  beforeEach(() => { bossNotices = []; ownerNotices = []; });

  test('сотрудник меняет СВОЮ задачу — успех, боссу отдельного уведомления нет', async () => {
    const r = await handler({ task_id: 12, status: 'done' },
      { channel: 'whatsapp', chatId: '7700', clientName: 'Али', role: 'employee' });
    await tick();
    assert.equal(r.success, true);
    assert.equal(bossNotices.length, 0);
    assert.equal(ownerNotices.length, 1, 'владелец плана уведомлён как раньше');
  });

  test('сотрудник меняет ЧУЖУЮ задачу — успех (не отказ) + уведомление боссу', async () => {
    const r = await handler({ task_id: 12, status: 'done' },
      { channel: 'whatsapp', chatId: '7999', clientName: 'Берик', role: 'employee' });
    await tick();
    assert.equal(r.success, true, 'отказа not_owner больше нет');
    assert.equal(bossNotices.length, 1);
    assert.match(bossNotices[0].text, /Берик/);
    assert.match(bossNotices[0].text, /чужую задачу #12/);
    assert.equal(bossNotices[0].opts.projectId, 5, 'projectId для дедупа с notifyOwner');
  });

  test('босс меняет любую задачу — уведомления боссу нет', async () => {
    const r = await handler({ task_id: 12, status: 'reassign' },
      { channel: 'whatsapp', chatId: '7999', clientName: 'Шеф', role: 'boss' });
    await tick();
    assert.equal(r.success, true);
    assert.equal(bossNotices.length, 0);
  });
});

'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

// Моки mysql + notifier для проверки авто-продвижения DAG.
let tasks = [];
const delivered = [];
const dispatched = [];
const mysqlMock = {
  getTask: async (id) => tasks.find((t) => t.id === id) || null,
  getEmployeeById: async (id) => ({ id, name: `Emp${id}`, channel: 'whatsapp', contact: `7700000000${id}` }),
  listTasksForProject: async (pid) => tasks.filter((t) => t.project_id === pid),
  markDispatched: async (id, sent) => { dispatched.push({ id, sent }); const t = tasks.find((x) => x.id === id); if (t) { t.dispatched = 1; t.status = 'dispatched'; } },
};
const notifierMock = { deliver: async (ch, c, text) => { delivered.push({ c, text }); return true; } };

const Module = require('module');
const originalRequire = Module.prototype.require;
Module.prototype.require = function (id) {
  if (id === './mysql') return mysqlMock;
  if (id === './notifier') return notifierMock;
  return originalRequire.apply(this, arguments);
};
const { dispatchReadySuccessors, dispatchTaskById, briefFromTask } = require('../src/services/dispatcher');
Module.prototype.require = originalRequire;

describe('dispatcher (auto-DAG)', () => {
  test('briefFromTask собирает описание/ожидаемое/срок', () => {
    const b = briefFromTask({ description: 'Собрать лотки', expected: '106 шт', deadline: '2026-06-12' });
    assert.match(b, /Собрать лотки/);
    assert.match(b, /Ожидаем: 106 шт/);
    assert.match(b, /Срок: 2026-06-12/);
  });

  test('dispatchReadySuccessors рассылает только готовых (deps сняты, есть assignee, не диспатчены)', async () => {
    delivered.length = 0; dispatched.length = 0;
    tasks = [
      { id: 1, project_id: 7, title: 'Собрать', status: 'done', dispatched: 1, assignee_id: 18, depends_on: null },
      { id: 2, project_id: 7, title: 'Вызвать машину', status: 'todo', dispatched: 0, assignee_id: 11, depends_on: '1' },
      { id: 3, project_id: 7, title: 'Документы', status: 'todo', dispatched: 0, assignee_id: 9, depends_on: '2' },
    ];
    const sent = await dispatchReadySuccessors(7);
    // #2 готов (его dep #1 done), #3 ждёт #2 → не диспатчится
    assert.equal(sent.length, 1);
    assert.equal(sent[0].task_id, 2);
    assert.equal(delivered.length, 1);
  });

  test('не диспатчит задачу без исполнителя', async () => {
    delivered.length = 0; dispatched.length = 0;
    tasks = [
      { id: 1, project_id: 7, title: 'A', status: 'done', dispatched: 1, assignee_id: 18, depends_on: null },
      { id: 2, project_id: 7, title: 'B', status: 'todo', dispatched: 0, assignee_id: null, depends_on: '1' },
    ];
    const sent = await dispatchReadySuccessors(7);
    assert.equal(sent.length, 0);
  });

  test('dispatchTaskById гейтит по незавершённым зависимостям', async () => {
    tasks = [
      { id: 1, project_id: 7, title: 'A', status: 'in_progress', dispatched: 1, assignee_id: 18, depends_on: null },
      { id: 2, project_id: 7, title: 'B', status: 'todo', dispatched: 0, assignee_id: 11, depends_on: '1' },
    ];
    const r = await dispatchTaskById(2, 'бриф');
    assert.equal(r.success, false);
    assert.equal(r.reason, 'blocked_by_deps');
  });
});

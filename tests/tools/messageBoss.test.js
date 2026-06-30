'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

// Моки mysql/notifier/config (паттерн tests/tools/messageEmployee.test.js).
const mysqlMock = {
  _emp: { id: 26, name: 'Имирали', roles: 'кладовщик' },
  _proj: null,
  _boss: null,
  findEmployeeByContact: async () => mysqlMock._emp,
  getLatestProjectForEmployee: async () => mysqlMock._proj,
  getTask: async (id) => (id === 44 ? { id: 44, project_id: 7, assignee_id: 26 } : null),
  getProject: async (id) => (id === 7 ? mysqlMock._proj : null),
  findBossRoute: async () => mysqlMock._boss,
};
const delivered = [];
let deliverOk = true;
const notifierMock = { deliver: async (channel, contact, text) => { delivered.push({ channel, contact, text }); return deliverOk; } };
const configMock = { BOSS_CONTACTS: [], MANAGER_TG: '', MANAGER_WA: '' };

const Module = require('module');
const orig = Module.prototype.require;
Module.prototype.require = function (id) {
  if (id === '../services/mysql') return mysqlMock;
  if (id === '../services/notifier') return notifierMock;
  if (id === '../config') return configMock;
  return orig.apply(this, arguments);
};
delete require.cache[require.resolve('../../src/tools/messageBoss')];
const { handler } = require('../../src/tools/messageBoss');
Module.prototype.require = orig;

const ctx = { channel: 'whatsapp', chatId: '77712280473', phone: '77712280473' };
function reset() { delivered.length = 0; deliverOk = true; mysqlMock._proj = null; mysqlMock._boss = null; configMock.BOSS_CONTACTS = []; configMock.MANAGER_TG = ''; }

describe('message_boss: маршрутизация', () => {
  test('нет проекта, но есть директор в реестре → уходит директору', async () => {
    reset();
    mysqlMock._boss = { channel: 'whatsapp', contact: '77775477227' };
    const r = await handler({ message: 'нужен шланг на базу', kind: 'request' }, ctx);
    assert.equal(r.success, true);
    assert.equal(r.routed_to, 'boss');
    assert.equal(delivered.length, 1);
    assert.equal(delivered[0].contact, '77775477227');
    assert.match(delivered[0].text, /Имирали/);
  });

  test('нет проекта и нет директора, но есть BOSS_CONTACTS → уходит туда', async () => {
    reset();
    configMock.BOSS_CONTACTS = ['77770000001'];
    const r = await handler({ message: 'вопрос', kind: 'question' }, ctx);
    assert.equal(r.success, true);
    assert.equal(delivered[0].contact, '77770000001');
  });

  test('явный task_id → уходит владельцу точного проекта с пометкой плана', async () => {
    reset();
    mysqlMock._proj = { title: 'Раздача базы', owner_channel: 'whatsapp', owner_chat_id: '77775477227' };
    const r = await handler({ message: 'опоздал', kind: 'problem', task_id: 44 }, ctx);
    assert.equal(r.success, true);
    assert.match(delivered[0].text, /Раздача базы/);
  });

  test('без task_id/project_id не угадывает маршрут по последнему проекту', async () => {
    reset();
    mysqlMock._proj = { title: 'Случайный старый план', owner_channel: 'whatsapp', owner_chat_id: '70000000000' };
    mysqlMock._boss = { channel: 'whatsapp', contact: '77775477227' };
    const r = await handler({ message: 'общий вопрос', kind: 'question' }, ctx);
    assert.equal(r.success, true);
    assert.equal(delivered[0].contact, '77775477227');
    assert.doesNotMatch(delivered[0].text, /Случайный старый план/);
  });

  test('ни одного маршрута / доставка провалилась → success:false, без вранья «передал»', async () => {
    reset();
    mysqlMock._boss = { channel: 'whatsapp', contact: '77775477227' };
    deliverOk = false; // доставка не проходит ни по одному маршруту
    const r = await handler({ message: 'вопрос', kind: 'question' }, ctx);
    assert.equal(r.success, false);
    assert.equal(r.reason, 'no_route');
    assert.match(r.message, /не смог|честно|позже/i);
  });

  test('отправитель не в реестре → success:false', async () => {
    reset();
    mysqlMock._emp = null;
    const r = await handler({ message: 'x' }, ctx);
    assert.equal(r.success, false);
    mysqlMock._emp = { id: 26, name: 'Имирали', roles: 'кладовщик' };
  });
});

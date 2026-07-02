'use strict';
// notifyBossAboutChange: уведомление босса об изменении общего ресурса не-боссом.
// Прозрачность вместо запретов: действия не блокируются, но босс в курсе.
const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const delivered = [];
const tgMock = { sendMessage: async (to, text) => { delivered.push({ ch: 'telegram', to, text }); return true; } };
const baileysMock = { sendMessage: async (to, text) => { delivered.push({ ch: 'whatsapp', to, text }); return true; } };
const igMock = { sendMessage: async () => true };
let bossRoute = null;
let project = null;
const mysqlMock = {
  getProject: async () => project,
  findBossRoute: async () => bossRoute,
};
const configMock = {
  BOSS_CONTACTS: ['77070001122'],
  MANAGER_TG: '9000',
  MANAGER_WA: '',
  MANAGER_GROUP_WA: '',
};

const Module = require('module');
const orig = Module.prototype.require;
Module.prototype.require = function (id) {
  if (id === './mysql') return mysqlMock;
  if (id === '../config') return configMock;
  if (id === '../channels/telegram') return tgMock;
  if (id === '../services/baileys') return baileysMock;
  if (id === '../channels/instagram') return igMock;
  if (id === '../agent/memory') return { recordOutbound: async () => {} };
  return orig.apply(this, arguments);
};
const notifier = require('../src/services/notifier');

describe('notifyBossAboutChange', () => {
  beforeEach(() => { delivered.length = 0; bossRoute = null; project = null; });

  test('действия самого босса не уведомляются (no-op)', async () => {
    const ok = await notifier.notifyBossAboutChange({ role: 'boss', chatId: '1' }, 'текст');
    assert.equal(ok, false);
    assert.equal(delivered.length, 0);
  });

  test('роутинг: сначала директор из реестра (findBossRoute)', async () => {
    bossRoute = { channel: 'telegram', contact: '424242' };
    const ok = await notifier.notifyBossAboutChange({ role: 'employee', chatId: 'emp1' }, '🔔 изменение');
    assert.equal(ok, true);
    assert.equal(delivered.length, 1);
    assert.deepEqual({ ch: delivered[0].ch, to: delivered[0].to }, { ch: 'telegram', to: '424242' });
  });

  test('fallback: без директора идёт в BOSS_CONTACTS (WhatsApp)', async () => {
    const ok = await notifier.notifyBossAboutChange({ role: 'employee', chatId: 'emp1' }, '🔔 изменение');
    assert.equal(ok, true);
    assert.equal(delivered[0].ch, 'whatsapp');
    assert.equal(delivered[0].to, '77070001122@s.whatsapp.net');
  });

  test('контакт актёра пропускается (не уведомляем человека о нём самом)', async () => {
    // Актёр и есть номер из BOSS_CONTACTS (например, пишет с этого номера, но role не boss)
    const ok = await notifier.notifyBossAboutChange(
      { role: 'employee', chatId: '77070001122@s.whatsapp.net', phone: '77070001122' }, '🔔 изменение'
    );
    // BOSS_CONTACTS скипнут → уйдёт в MANAGER_TG
    assert.equal(ok, true);
    assert.equal(delivered[0].ch, 'telegram');
    assert.equal(delivered[0].to, '9000');
  });

  test('projectId: владелец плана уже уведомлён notifyOwner — его контакт скипается', async () => {
    project = { id: 5, owner_channel: 'whatsapp', owner_chat_id: '77070001122' };
    const ok = await notifier.notifyBossAboutChange({ role: 'employee', chatId: 'emp1' }, '🔔', { projectId: 5 });
    // BOSS_CONTACTS совпал с владельцем → скип → MANAGER_TG
    assert.equal(ok, true);
    assert.equal(delivered[0].ch, 'telegram');
  });

  test('пустой текст → no-op', async () => {
    const ok = await notifier.notifyBossAboutChange({ role: 'employee', chatId: 'x' }, '');
    assert.equal(ok, false);
    assert.equal(delivered.length, 0);
  });
});

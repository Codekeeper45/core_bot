'use strict';
// senderSignature: имя из реестра, роль руководителя из BOSS_CONTACTS, контакт по каналу.
const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');

let empByContact = {};
const mysqlMock = {
  findEmployeeByContact: async (channel, contact) => empByContact[`${channel}:${String(contact)}`] || null,
};
const configMock = { BOSS_CONTACTS: ['77070009999'] };

const orig = Module.prototype.require;
Module.prototype.require = function (id) {
  if (id === './mysql') return mysqlMock;
  if (id === '../config') return configMock;
  return orig.apply(this, arguments);
};
delete require.cache[require.resolve('../../src/services/senderIdentity')];
const { senderSignature } = require('../../src/services/senderIdentity');

describe('senderSignature', () => {
  beforeEach(() => { empByContact = {}; });

  test('сотрудник из реестра: имя + роль + WhatsApp-контакт', async () => {
    empByContact['whatsapp:77071234567@s.whatsapp.net'] = { name: 'Али Мякота', roles: 'кладовщик' };
    const sig = await senderSignature({ channel: 'whatsapp', chatId: '77071234567@s.whatsapp.net', clientName: 'ali wa', role: 'employee' });
    assert.equal(sig.name, 'Али Мякота');
    assert.equal(sig.line, '📨 От: Али Мякота (кладовщик, WhatsApp +77071234567)');
  });

  test('босс по BOSS_CONTACTS: роль «руководитель», имя из реестра/контекста', async () => {
    const sig = await senderSignature({ channel: 'whatsapp', chatId: '77070009999@s.whatsapp.net', clientName: 'Шеф', role: 'boss' });
    assert.equal(sig.role, 'руководитель');
    assert.match(sig.line, /От: Шеф \(руководитель, WhatsApp \+77070009999\)/);
  });

  test('не в реестре: фолбэк на имя из мессенджера', async () => {
    const sig = await senderSignature({ channel: 'whatsapp', chatId: '77009998877@s.whatsapp.net', clientName: 'Неизвестный Клиент' });
    assert.match(sig.line, /От: Неизвестный Клиент/);
    assert.match(sig.line, /\+77009998877/);
  });

  test('поиск в реестре по цифрам телефона (fallback для LID)', async () => {
    empByContact['whatsapp:77071234567'] = { name: 'Али', roles: 'кладовщик' };
    const sig = await senderSignature({ channel: 'whatsapp', chatId: 'opaque@lid', phone: '77071234567' });
    assert.equal(sig.name, 'Али');
  });

  test('telegram: @username как контакт', async () => {
    const sig = await senderSignature({ channel: 'telegram', chatId: '5551', phone: '@ivan_dev', clientName: 'Иван' });
    assert.match(sig.line, /Telegram @ivan_dev/);
  });

  test('instagram: @username', async () => {
    const sig = await senderSignature({ channel: 'instagram', chatId: 'client.insta', clientName: 'Клиент' });
    assert.match(sig.line, /Instagram @client\.insta/);
  });

  test('совсем пустой контекст не падает', async () => {
    const sig = await senderSignature({});
    assert.match(sig.line, /От: неизвестный отправитель/);
  });
});

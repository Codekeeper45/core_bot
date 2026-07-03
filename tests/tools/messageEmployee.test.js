'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

// Моки mysql.findEmployees и notifier.deliver через подмену require.
let employees = [];
const delivered = [];
const mysqlMock = { findEmployees: async () => employees };
const notifierMock = { deliver: async (channel, contact, text) => { delivered.push({ channel, contact, text }); return true; } };
const senderIdentityMock = { senderSignature: async () => ({ line: '📨 От: Али (кладовщик, WhatsApp +77071234567)', name: 'Али' }) };

const Module = require('module');
const originalRequire = Module.prototype.require;
Module.prototype.require = function (id) {
  if (id === '../services/mysql') return mysqlMock;
  if (id === '../services/notifier') return notifierMock;
  if (id === '../services/senderIdentity') return senderIdentityMock;
  return originalRequire.apply(this, arguments);
};
const { handler } = require('../../src/tools/messageEmployee');
Module.prototype.require = originalRequire;

describe('message_employee', () => {
  test('sends to first matching employee with contact', async () => {
    employees = [
      { id: 1, name: 'Без контакта', contact: null, channel: null },
      { id: 2, name: 'Директор', contact: '77075301259', channel: 'whatsapp' },
      { id: 3, name: 'Второй', contact: '77070000000', channel: 'whatsapp' },
    ];
    delivered.length = 0;
    const r = await handler({ to: 'Директор', message: 'Привет' });
    assert.equal(r.success, true);
    assert.equal(r.count, 1);
    assert.equal(delivered.length, 1);
    assert.equal(delivered[0].contact, '77075301259');
    // Сообщение автоматически подписано отправителем.
    assert.equal(delivered[0].text, '📨 От: Али (кладовщик, WhatsApp +77071234567)\n\nПривет');
    assert.match(r.signed_as, /От: Али/);
  });

  test('to_all broadcasts to all matches with contact', async () => {
    employees = [
      { id: 1, name: 'Кладовщик А', contact: '7700000001', channel: 'whatsapp' },
      { id: 2, name: 'Кладовщик Б', contact: '7700000002', channel: 'whatsapp' },
      { id: 3, name: 'Кладовщик без тел', contact: null, channel: null },
    ];
    delivered.length = 0;
    const r = await handler({ to: 'кладовщик', message: 'Инвентаризация в 9:00', to_all: true });
    assert.equal(r.success, true);
    assert.equal(r.count, 2);
    assert.equal(delivered.length, 2);
  });

  test('fails cleanly when nobody has a contact', async () => {
    employees = [{ id: 1, name: 'X', contact: null, channel: null }];
    delivered.length = 0;
    const r = await handler({ to: 'X', message: 'hi' });
    assert.equal(r.success, false);
    assert.equal(r.reason, 'no_recipient');
    assert.equal(delivered.length, 0);
  });

  test('requires to and message', async () => {
    const r = await handler({ to: '', message: '' });
    assert.equal(r.success, false);
  });
});

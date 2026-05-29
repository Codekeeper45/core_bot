'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

let capturedHandoff = null;

const mysqlMock = {
  setHandoff: async (...args) => {
    capturedHandoff = args;
  },
};

const configMock = {
  MANAGER_NAME: 'Менеджер',
  MANAGER_GROUP_WA: '',
  MANAGER_WA: '',
  MANAGER_TG: '',
  HANDOFF_TTL: 3600,
};

const Module = require('module');
const originalRequire = Module.prototype.require;
Module.prototype.require = function (id) {
  if (id === '../services/mysql') return mysqlMock;
  if (id === '../config') return configMock;
  return originalRequire.apply(this, arguments);
};

const { runNotifyManager } = require('../../src/tools/notifyManager');
Module.prototype.require = originalRequire;

describe('runNotifyManager', () => {
  test('returns the docs escalation message', async () => {
    capturedHandoff = null;
    const result = await runNotifyManager({
      channel: 'whatsapp',
      client_name: 'Алия',
      phone: '77001234567',
      chat_id: '12345',
      summary: 'Нужен звонок',
      event_type: 'lead_qualified',
    });

    assert.equal(result.success, true);
    assert.equal(result.client_message, 'Сейчас передам ваш вопрос нашему специалисту. Он свяжется с вами в течение 30 минут. Спасибо за терпение!');
    assert.ok(capturedHandoff);
    assert.equal(capturedHandoff[0], 'whatsapp');
    assert.equal(capturedHandoff[1], '12345');
  });
});

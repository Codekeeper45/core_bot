'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

let employeeRow = null;
const mysqlMock = { findEmployeeByContact: async () => employeeRow };
const configMock = { BOSS_CONTACTS: ['77075301259'] };

const Module = require('module');
const originalRequire = Module.prototype.require;
Module.prototype.require = function (id) {
  if (id === '../services/mysql') return mysqlMock;
  if (id === '../config') return configMock;
  return originalRequire.apply(this, arguments);
};
const { isAllowedSender } = require('../src/middleware/access');
Module.prototype.require = originalRequire;

describe('isAllowedSender', () => {
  test('boss contact is allowed (role=boss)', async () => {
    employeeRow = null;
    const r = await isAllowedSender('whatsapp', '77075301259');
    assert.equal(r.allowed, true);
    assert.equal(r.role, 'boss');
  });

  test('registered employee is allowed (role=employee)', async () => {
    employeeRow = { id: 12, name: 'Тимур' };
    const r = await isAllowedSender('whatsapp', '77070000000');
    assert.equal(r.allowed, true);
    assert.equal(r.role, 'employee');
  });

  test('unknown sender is rejected', async () => {
    employeeRow = null;
    const r = await isAllowedSender('whatsapp', '77079999999');
    assert.equal(r.allowed, false);
    assert.equal(r.role, null);
  });
});

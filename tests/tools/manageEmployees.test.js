'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

// Мок mysql (паттерн tests/tools/listEmployees.test.js). normalizePhone — настоящий.
const mysqlMock = {
  _byContact: null, // что вернёт findEmployeeByContact
  _find: [],        // что вернёт findEmployees (для update/remove)
  addEmployee: async () => 99,
  updateEmployee: async () => {},
  deactivateEmployee: async () => {},
  findEmployees: async () => mysqlMock._find,
  findEmployeeByContact: async () => mysqlMock._byContact,
};

const Module = require('module');
const orig = Module.prototype.require;
Module.prototype.require = function (id) {
  if (id === '../services/mysql') return mysqlMock;
  return orig.apply(this, arguments);
};
delete require.cache[require.resolve('../../src/tools/manageEmployees')];
const { handler } = require('../../src/tools/manageEmployees');
Module.prototype.require = orig;

describe('manage_employees: дубликат телефона — честно, не молча', () => {
  test('add с занятым номером → не добавлен, причина названа', async () => {
    mysqlMock._byContact = { id: 5, name: 'Иван' };
    const r = await handler({ action: 'add', employees: [{ name: 'Новый', phone: '+7 707 111 22 33' }] });
    assert.equal(r.added_count, 0);
    assert.equal(r.success, false);
    assert.match(r.message, /Иван/);
    assert.ok(Array.isArray(r.skipped) && r.skipped.length === 1);
  });

  test('add со свободным номером → добавлен', async () => {
    mysqlMock._byContact = null;
    const r = await handler({ action: 'add', employees: [{ name: 'Новый', phone: '+7 707 999 88 77' }] });
    assert.equal(r.success, true);
    assert.equal(r.added_count, 1);
  });

  test('update телефона на чужой занятый → отказ с пояснением', async () => {
    mysqlMock._find = [{ id: 10, name: 'Цель', roles: 'r' }];
    mysqlMock._byContact = { id: 5, name: 'Иван' }; // другой сотрудник
    const r = await handler({ action: 'update', query: 'Цель', fields: { phone: '+7 707 111 22 33' } });
    assert.equal(r.success, false);
    assert.match(r.message, /уже у|Иван/i);
  });

  test('update своего же номера (дубль = он сам) → проходит', async () => {
    mysqlMock._find = [{ id: 5, name: 'Сам', roles: 'r' }];
    mysqlMock._byContact = { id: 5, name: 'Сам' }; // тот же id
    const r = await handler({ action: 'update', query: 'Сам', fields: { phone: '+7 707 111 22 33' } });
    assert.equal(r.success, true);
  });
});

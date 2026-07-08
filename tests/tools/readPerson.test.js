'use strict';
// read_person: резолв человека (findEmployees), выборка его переписки (archiveByPerson),
// граница приватности через viewer, обработка not_found/ambiguous/ошибки БД.
const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');

let employees = [];
let archiveRows = [];
let archiveThrows = null;
let lastArchiveArgs = null;

const mysqlMock = {
  findEmployees: async () => employees,
  archiveByPerson: async (a) => {
    lastArchiveArgs = a;
    if (archiveThrows) throw archiveThrows;
    return archiveRows;
  },
};

const originalRequire = Module.prototype.require;
Module.prototype.require = function (id) {
  if (id === '../services/mysql') return mysqlMock;
  return originalRequire.apply(this, arguments);
};
delete require.cache[require.resolve('../../src/tools/readPerson')];
const { handler } = require('../../src/tools/readPerson');
Module.prototype.require = originalRequire;

const ctxBoss = { channel: 'whatsapp', chatId: '77070009999@s.whatsapp.net', role: 'boss' };
const ctxEmp = { channel: 'whatsapp', chatId: '77071112233@s.whatsapp.net', role: 'employee' };

describe('read_person', () => {
  beforeEach(() => { employees = []; archiveRows = []; archiveThrows = null; lastArchiveArgs = null; });

  test('пустой who → empty_who', async () => {
    const r = await handler({ who: '  ' }, ctxBoss);
    assert.equal(r.success, false);
    assert.equal(r.reason, 'empty_who');
  });

  test('никого не нашли → not_found', async () => {
    employees = [];
    const r = await handler({ who: 'Ктотонибудь' }, ctxBoss);
    assert.equal(r.success, false);
    assert.equal(r.reason, 'not_found');
  });

  test('несколько совпадений → ambiguous с кандидатами', async () => {
    employees = [
      { id: 2, name: 'Иван Петров', roles: 'кладовщик', channel: 'whatsapp', contact: '77071234567' },
      { id: 5, name: 'Иван Сидоров', roles: 'водитель', channel: 'whatsapp', contact: '77079998877' },
    ];
    const r = await handler({ who: 'Иван' }, ctxBoss);
    assert.equal(r.success, false);
    assert.equal(r.reason, 'ambiguous');
    assert.equal(r.candidates.length, 2);
    assert.equal(r.candidates[0].id, 2);
  });

  test('один матч → переписка, who = имя/Бот, viewer проброшен', async () => {
    employees = [{ id: 2, name: 'Али Мякота', roles: 'кладовщик', channel: 'whatsapp', contact: '77071234567' }];
    archiveRows = [
      { role: 'user', actor_name: 'Али Мякота', content: 'сколько лотков дн200', created_at: '2026-07-08T05:00:00Z' },
      { role: 'assistant', actor_name: 'Бот', content: 'на складе 120', created_at: '2026-07-08T05:00:05Z' },
    ];
    const r = await handler({ who: 'кладовщик', query: 'лотки дн200' }, ctxEmp);
    assert.equal(r.success, true);
    assert.equal(r.person.id, 2);
    assert.equal(r.count, 2);
    assert.equal(r.messages[0].who, 'Али Мякота');
    assert.equal(r.messages[1].who, 'Бот');
    // person и viewer переданы в выборку; не-босс → isBoss=false.
    assert.equal(lastArchiveArgs.person.contact, '77071234567');
    assert.equal(lastArchiveArgs.viewer.isBoss, false);
    assert.deepEqual(lastArchiveArgs.tokens, ['лотки', 'дн200']);
  });

  test('босс → viewer.isBoss=true', async () => {
    employees = [{ id: 3, name: 'Води Тель', roles: 'водитель', channel: 'telegram', contact: '555111' }];
    archiveRows = [];
    await handler({ who: '3' }, ctxBoss);
    assert.equal(lastArchiveArgs.viewer.isBoss, true);
  });

  test('пустой результат → note про приватность', async () => {
    employees = [{ id: 2, name: 'Али', roles: 'кладовщик', channel: 'whatsapp', contact: '77071234567' }];
    archiveRows = [];
    const r = await handler({ who: 'Али' }, ctxEmp);
    assert.equal(r.success, true);
    assert.equal(r.count, 0);
    assert.match(r.note, /приватн/i);
  });

  test('битая дата from → bad_from', async () => {
    employees = [{ id: 2, name: 'Али', channel: 'whatsapp', contact: '77071234567' }];
    const r = await handler({ who: 'Али', from: 'вчера' }, ctxBoss);
    assert.equal(r.success, false);
    assert.equal(r.reason, 'bad_from');
  });

  test('from позже to → bad_range', async () => {
    employees = [{ id: 2, name: 'Али', channel: 'whatsapp', contact: '77071234567' }];
    const r = await handler({ who: 'Али', from: '2026-07-08', to: '2026-07-01' }, ctxBoss);
    assert.equal(r.success, false);
    assert.equal(r.reason, 'bad_range');
  });

  test('сбой БД → error:db', async () => {
    employees = [{ id: 2, name: 'Али', channel: 'whatsapp', contact: '77071234567' }];
    archiveThrows = Object.assign(new Error('conn lost'), { dbError: true });
    const r = await handler({ who: 'Али' }, ctxBoss);
    assert.equal(r.success, false);
    assert.equal(r.error, 'db');
  });
});

'use strict';

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');

const policies = [];
const accounts = new Map();
const mysqlMock = {
  createPolicy: async (data) => {
    const row = {
      id: policies.length + 1,
      policyKey: data.policyKey,
      status: data.status,
      version: 1,
      ...data,
    };
    policies.push(row);
    return row;
  },
  listPolicies: async (status) => policies.filter((p) => !status || p.status === status),
  setPolicyStatus: async (id, status, approvedBy) => {
    const row = policies.find((p) => p.id === id);
    if (!row) return null;
    row.status = status;
    row.approvedBy = approvedBy;
    return { id, policyKey: row.policyKey, status };
  },
  ledgerOpenAccount: async ({ accountKey, title, currency }) => {
    const key = accountKey.toLowerCase();
    const account = { id: accounts.size + 1, account_key: key, title, currency };
    accounts.set(key, { account, entries: [] });
    return account;
  },
  ledgerAddEntry: async ({ accountKey, amount, note, sourceMessageId }) => {
    const state = accounts.get(accountKey.toLowerCase());
    if (!state) return null;
    const entry = {
      id: state.entries.length + 1,
      amount,
      note,
      source_message_id: sourceMessageId,
      effective_at: new Date('2026-07-28T10:00:00Z'),
    };
    state.entries.push(entry);
    return { id: entry.id, account: state.account };
  },
  ledgerGet: async (key, limit) => {
    const state = accounts.get(key.toLowerCase());
    if (!state) return null;
    return {
      account: state.account,
      balance: state.entries.reduce((sum, entry) => sum + entry.amount, 0),
      entries: state.entries.slice(-limit).reverse(),
    };
  },
};
const notifierMock = { notifyBossAboutChange: async () => true };
const configMock = {
  POLICY_ADMIN_CONTACTS: ['77770000001'],
  SCHEDULER_TZ_OFFSET_MIN: 300,
};

const originalRequire = Module.prototype.require;
Module.prototype.require = function (id) {
  if (id === '../services/mysql') return mysqlMock;
  if (id === '../services/notifier') return notifierMock;
  if (id === '../config') return configMock;
  return originalRequire.apply(this, arguments);
};
delete require.cache[require.resolve('../../src/tools/managePolicy')];
delete require.cache[require.resolve('../../src/tools/manageLedger')];
const policy = require('../../src/tools/managePolicy');
const ledger = require('../../src/tools/manageLedger');
Module.prototype.require = originalRequire;

describe('manage_policy', () => {
  beforeEach(() => { policies.length = 0; accounts.clear(); });

  test('employee proposal stays pending; boss proposal becomes active', async () => {
    const employee = await policy.handler({
      action: 'propose',
      policy_key: 'response.style',
      policy_text: 'Отвечать нейтрально.',
    }, { role: 'employee', clientName: 'Али', chatId: '1' });
    assert.equal(employee.status, 'pending');

    const boss = await policy.handler({
      action: 'propose',
      policy_key: 'price.internal',
      policy_text: 'Для внутренних расчётов использовать скидочную цену.',
    }, { role: 'boss', clientName: 'Стас', chatId: '2' });
    assert.equal(boss.status, 'active');
  });

  test('configured administrator can approve a pending policy', async () => {
    policies.push({ id: 1, policyKey: 'response.style', status: 'pending' });
    const result = await policy.handler(
      { action: 'approve', id: 1 },
      { role: 'employee', clientName: 'Админ', phone: '+7 777 000 00 01' }
    );
    assert.equal(result.success, true);
    assert.equal(result.status, 'active');
  });
});

describe('manage_ledger', () => {
  beforeEach(() => { policies.length = 0; accounts.clear(); });

  test('balance is the sum of auditable signed entries', async () => {
    const context = { clientName: 'Стас', sourceMessageId: 'msg-10' };
    await ledger.handler({
      action: 'open',
      account_key: 'ruslan_debt',
      title: 'Долг Руслана',
    }, context);
    await ledger.handler({ action: 'add', account_key: 'ruslan_debt', amount: 35000, note: 'Подтверждено' }, context);
    await ledger.handler({ action: 'add', account_key: 'ruslan_debt', amount: -5000, note: 'Оплата' }, context);
    const result = await ledger.handler({ action: 'history', account_key: 'ruslan_debt' }, context);
    assert.equal(result.balance, 30000);
    assert.equal(result.entries.length, 2);
    assert.equal(result.entries[0].source_message_id, 'msg-10');
  });
});

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

test('create_project принимает deadline для каждой подзадачи', () => {
  const { definition } = require('../../src/tools/createProject');
  const taskProps = definition.function.parameters.properties.tasks.items.properties;
  assert.equal(taskProps.deadline.type, 'string');
});

test('отменённые задачи являются терминальными, но не выполненными', () => {
  const { rollupStatus } = require('../../src/utils/projectRollup');
  assert.equal(rollupStatus({ total: 3, done: 2, cancelled: 1, blocked: 0 }), 'done');
  assert.equal(rollupStatus({ total: 3, done: 1, cancelled: 1, blocked: 0 }), 'active');
});

test('дедупликация различает одинаковый текст с разными provider message id', () => {
  const { isDuplicate, _resetForTests } = require('../../src/middleware/deduplication');
  _resetForTests();
  assert.equal(isDuplicate('whatsapp', '7700', 'готово', 'msg-1'), false);
  assert.equal(isDuplicate('whatsapp', '7700', 'готово', 'msg-1'), true);
  assert.equal(isDuplicate('whatsapp', '7700', 'готово', 'msg-2'), false);
});

test('Baileys обрабатывает все входящие сообщения из batch', () => {
  const baileys = require('../../src/services/baileys');
  const valid1 = { key: { remoteJid: '1@s.whatsapp.net', fromMe: false }, message: { conversation: 'a' } };
  const valid2 = { key: { remoteJid: '2@s.whatsapp.net', fromMe: false }, message: { conversation: 'b' } };
  const outgoing = { key: { remoteJid: '3@s.whatsapp.net', fromMe: true }, message: { conversation: 'c' } };
  assert.deepEqual(baileys._inboundBatch([valid1, outgoing, valid2]), [valid1, valid2]);
});

test('конкурентное сохранение истории сохраняет и исходящее, и новый ход', () => {
  const { _mergeHistory } = require('../../src/services/mysql');
  const base = [{ role: 'user', content: 'начало' }];
  const current = [...base, { role: 'assistant', content: 'проактивное сообщение' }];
  const incoming = [...base, { role: 'user', content: 'новый вопрос' }];
  assert.deepEqual(_mergeHistory(current, incoming), [
    ...base,
    { role: 'assistant', content: 'проактивное сообщение' },
    { role: 'user', content: 'новый вопрос' },
  ]);
});

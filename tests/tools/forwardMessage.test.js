'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

// Моки mysql / notifier / incomingMedia (паттерн tests/tools/messageEmployee.test.js).
let employees = [];
const delivered = [];
const mysqlMock = { findEmployees: async () => employees };
const notifierMock = {
  deliver: async (channel, contact, text, media = null) => {
    delivered.push({ channel, contact, text, kind: media && media.kind, fileName: media && media.fileName });
    return true;
  },
};
const senderIdentityMock = { senderSignature: async () => ({ line: '📨 От: Босс (руководитель, WhatsApp +77070000000)', name: 'Босс' }) };
const incomingMock = {
  downloadIncoming: async (desc) => {
    if (desc.type === 'document' && desc.__fail) throw new Error('download failed');
    return { buffer: Buffer.from('x'), mime: desc.mime || 'application/octet-stream', fileName: desc.file_name || 'f' };
  },
};

const Module = require('module');
const orig = Module.prototype.require;
Module.prototype.require = function (id) {
  if (id === '../services/mysql') return mysqlMock;
  if (id === '../services/notifier') return notifierMock;
  if (id === '../media/incomingMedia') return incomingMock;
  if (id === '../services/senderIdentity') return senderIdentityMock;
  return orig.apply(this, arguments);
};
delete require.cache[require.resolve('../../src/tools/forwardMessage')];
const { handler, definition } = require('../../src/tools/forwardMessage');
Module.prototype.require = orig;

const img = { type: 'image', channel: 'whatsapp', baileys_media_obj: {}, file_name: 'photo.jpg', mime: 'image/jpeg' };
const doc = { type: 'document', channel: 'telegram', file_id: 'F1', file_name: 'смета.pdf', mime: 'application/pdf' };

describe('forward_message', () => {
  test('definition: имя и to обязателен; не boss-only по смыслу', () => {
    assert.equal(definition.function.name, 'forward_message');
    assert.deepEqual(definition.function.parameters.required, ['to']);
  });

  test('пересылает фото+документ найденному сотруднику реальными вложениями', async () => {
    employees = [{ id: 2, name: 'Иван', contact: '77071112233', channel: 'telegram' }];
    delivered.length = 0;
    const r = await handler({ to: 'Иван' }, { incomingMedia: [img, doc] });
    assert.equal(r.success, true);
    assert.equal(r.forwarded.images, 1);
    assert.equal(r.forwarded.documents, 1);
    // Первым всегда уходит подпись «От: …» (даже без комментария), затем вложения.
    assert.equal(delivered.length, 3);
    assert.match(delivered[0].text, /^📨 От: Босс/);
    assert.ok(!delivered[0].kind);
    assert.deepEqual(delivered.slice(1).map((d) => d.kind).sort(), ['document', 'image']);
    assert.equal(delivered.every((d) => d.contact === '77071112233'), true);
    assert.match(r.signed_as, /От: Босс/);
  });

  test('с комментарием: сначала текст, потом вложение', async () => {
    employees = [{ id: 2, name: 'Иван', contact: 'c', channel: 'whatsapp' }];
    delivered.length = 0;
    const r = await handler({ to: 'Иван', message: 'смотри смету' }, { incomingMedia: [doc] });
    assert.equal(r.success, true);
    assert.equal(delivered.length, 2);
    // Текст первым и с подписью отправителя первой строкой.
    assert.equal(delivered[0].text, '📨 От: Босс (руководитель, WhatsApp +77070000000)\n\nсмотри смету');
    assert.ok(!delivered[0].kind); // текстовое — без media
    assert.equal(delivered[1].kind, 'document');
  });

  test('нет вложений и нет текста → отказ', async () => {
    employees = [{ id: 2, name: 'Иван', contact: 'c', channel: 'whatsapp' }];
    delivered.length = 0;
    const r = await handler({ to: 'Иван' }, { incomingMedia: [] });
    assert.equal(r.success, false);
    assert.match(r.message, /Нечего пересылать/);
    assert.equal(delivered.length, 0);
  });

  test('получатель без контакта / не найден → no_recipient', async () => {
    employees = [{ id: 3, name: 'Безконтактный', contact: null, channel: null }];
    const r = await handler({ to: 'кто-то' }, { incomingMedia: [img] });
    assert.equal(r.success, false);
    assert.equal(r.reason, 'no_recipient');
  });

  test('to_all → шлёт всем подходящим с контактом', async () => {
    employees = [
      { id: 1, name: 'A', contact: 'a', channel: 'whatsapp' },
      { id: 2, name: 'B', contact: 'b', channel: 'telegram' },
      { id: 3, name: 'NoContact', contact: null, channel: null },
    ];
    delivered.length = 0;
    const r = await handler({ to: 'кладовщик', to_all: true }, { incomingMedia: [img] });
    assert.equal(r.success, true);
    assert.equal(r.total, 2); // только с контактом
    assert.equal(delivered.length, 4); // каждому: подпись + вложение
  });

  test('ошибка скачивания одного вложения не валит остальное', async () => {
    employees = [{ id: 2, name: 'Иван', contact: 'c', channel: 'whatsapp' }];
    delivered.length = 0;
    const r = await handler({ to: 'Иван' }, { incomingMedia: [img, { ...doc, __fail: true }] });
    assert.equal(r.success, true); // фото ушло
    assert.equal(delivered.length, 2); // подпись + фото
    assert.equal(delivered[1].kind, 'image');
    assert.ok(Array.isArray(r.failed_media) && r.failed_media.length === 1);
    assert.match(r.note, /не удалось скачать/);
  });

  test('текст без вложений → одно текстовое сообщение', async () => {
    employees = [{ id: 2, name: 'Иван', contact: 'c', channel: 'whatsapp' }];
    delivered.length = 0;
    const r = await handler({ to: 'Иван', message: 'привет' }, { incomingMedia: [] });
    assert.equal(r.success, true);
    assert.equal(delivered.length, 1);
    assert.equal(delivered[0].text, '📨 От: Босс (руководитель, WhatsApp +77070000000)\n\nпривет');
  });
});

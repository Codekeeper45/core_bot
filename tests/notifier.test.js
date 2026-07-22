'use strict';
process.env.OBSERVE_ONLY_GROUP_WA = '120363000000000000@g.us';
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

// notifier.deliver лениво требует каналы и память ВНУТРИ вызова, поэтому подмену
// require держим активной на весь файл (node:test изолирует файлы по процессам).
const recorded = [];
const memoryMock = { recordOutbound: async (ch, key, text) => { recorded.push({ ch, key, text }); } };
const noop = async () => {};
const baileysMock = { sendMessage: noop, sendImage: noop, sendDocument: noop, sendVoice: noop };
const tgMock = { sendMessage: noop, sendPhoto: noop, sendDocument: noop, sendVoice: noop };
const igMock = { sendMessage: noop };
const mysqlMock = { getProject: async () => null };

const Module = require('module');
const orig = Module.prototype.require;
Module.prototype.require = function (id) {
  if (id === './mysql') return mysqlMock;
  if (id === '../channels/telegram') return tgMock;
  if (id === '../services/baileys') return baileysMock;
  if (id === '../channels/instagram') return igMock;
  if (id === '../agent/memory') return memoryMock;
  return orig.apply(this, arguments);
};
const notifier = require('../src/services/notifier');

describe('deliver: запись исходящего (record) под верным ключом истории', () => {
  test('WhatsApp record → ключ = JID (как у входящей переписки)', async () => {
    recorded.length = 0;
    const ok = await notifier.deliver('whatsapp', '77071234567', 'Задача #5: собрать лотки', null, { record: true });
    assert.equal(ok, true);
    assert.equal(recorded.length, 1);
    assert.equal(recorded[0].ch, 'whatsapp');
    assert.equal(recorded[0].key, '77071234567@s.whatsapp.net');
    assert.equal(recorded[0].text, 'Задача #5: собрать лотки');
  });

  test('Telegram record → ключ = chat_id как есть', async () => {
    recorded.length = 0;
    await notifier.deliver('telegram', '555', 'Напоминание', null, { record: true });
    assert.equal(recorded[0].key, '555');
  });

  test('без record → в историю НЕ пишем (ops-алерты, эхо и т.п.)', async () => {
    recorded.length = 0;
    await notifier.deliver('whatsapp', '77071234567', 'Просто сообщение');
    assert.equal(recorded.length, 0);
  });

  test('наблюдаемая группа read-only → исходящее сообщение блокируется', async () => {
    recorded.length = 0;
    const ok = await notifier.deliver('whatsapp', '120363000000000000@g.us', 'не писать в группу');
    assert.equal(ok, false);
    assert.equal(recorded.length, 0);
  });

  test('пересылка медиа без текста → пишем описание вложения', async () => {
    recorded.length = 0;
    await notifier.deliver('whatsapp', '7707', '', { kind: 'image', buffer: Buffer.from('x') }, { record: true });
    assert.equal(recorded[0].text, '[фото]');
    recorded.length = 0;
    await notifier.deliver('whatsapp', '7707', '', { kind: 'document', buffer: Buffer.from('x'), fileName: 'счёт.pdf' }, { record: true });
    assert.equal(recorded[0].text, '[файл: счёт.pdf]');
  });
});

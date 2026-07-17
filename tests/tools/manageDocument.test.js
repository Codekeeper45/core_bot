'use strict';
// manage_document: create (сборка из spec) и edit (хирургическая правкa присланного .docx).
const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');
const JSZip = require('jszip');
const { buildDocx } = require('../../src/services/docxBuilder');

const delivered = [];
let deliverOk = true;
let stashEntry = null; // { fileName, buffer }

const notifierMock = { deliver: async (...args) => { delivered.push(args); return deliverOk; } };
const stashMock = { get: (_ch, _id, _name) => stashEntry };

const originalRequire = Module.prototype.require;
Module.prototype.require = function (id) {
  if (id === '../services/notifier') return notifierMock;
  if (id === '../services/docBinaryStash') return stashMock;
  return originalRequire.apply(this, arguments);
};
delete require.cache[require.resolve('../../src/tools/manageDocument')];
const { handler } = require('../../src/tools/manageDocument');
Module.prototype.require = originalRequire;

const ctx = { channel: 'whatsapp', chatId: '7700' };
async function deliveredXml() {
  const zip = await JSZip.loadAsync(delivered[0][3].buffer);
  return zip.file('word/document.xml').async('string');
}

describe('manage_document', () => {
  beforeEach(() => { delivered.length = 0; deliverOk = true; stashEntry = null; });

  test('create: собирает и отправляет .docx', async () => {
    const r = await handler({ action: 'create', file_name: 'Договор', spec: {
      title: 'ДОГОВОР', blocks: [{ type: 'paragraph', text: 'Тело договора.' }],
    } }, ctx);
    assert.equal(r.success, true);
    assert.equal(r.action, 'create');
    assert.match(r.file_name, /\.docx$/);
    assert.equal(delivered.length, 1);
    assert.equal(delivered[0][3].mimetype, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    assert.match(await deliveredXml(), /ДОГОВОР/);
  });

  test('create: пустой spec → empty_spec, ничего не отправлено', async () => {
    const r = await handler({ action: 'create', spec: { blocks: [] } }, ctx);
    assert.equal(r.success, false);
    assert.equal(r.reason, 'empty_spec');
    assert.equal(delivered.length, 0);
  });

  test('edit: правит присланный .docx, шлёт новый файл, оригинал не трогает', async () => {
    const buffer = await buildDocx({ blocks: [{ type: 'paragraph', text: 'Сумма 1 000 000 тенге.' }] });
    stashEntry = { fileName: 'договор.docx', buffer };
    const r = await handler({ action: 'edit', file: 'last', edits: [{ find: '1 000 000', replace: '2 000 000' }] }, ctx);
    assert.equal(r.success, true);
    assert.equal(r.source, 'договор.docx');
    assert.match(r.file_name, /\(ред\.\)\.docx$/);
    assert.equal(r.applied['1 000 000'], 1);
    assert.match(await deliveredXml(), /2 000 000/);
  });

  test('edit: нет файла в стэше → not_in_stash', async () => {
    stashEntry = null;
    const r = await handler({ action: 'edit', edits: [{ find: 'a', replace: 'b' }] }, ctx);
    assert.equal(r.success, false);
    assert.equal(r.reason, 'not_in_stash');
    assert.equal(delivered.length, 0);
  });

  test('edit: текст не найден → no_match c not_found', async () => {
    stashEntry = { fileName: 'd.docx', buffer: await buildDocx({ blocks: [{ type: 'paragraph', text: 'Привет' }] }) };
    const r = await handler({ action: 'edit', edits: [{ find: 'ОТСУТСТВУЕТ', replace: 'x' }] }, ctx);
    assert.equal(r.success, false);
    assert.equal(r.reason, 'no_match');
    assert.deepEqual(r.not_found, ['ОТСУТСТВУЕТ']);
    assert.equal(delivered.length, 0);
  });

  test('edit: без edits → no_edits', async () => {
    stashEntry = { fileName: 'd.docx', buffer: Buffer.from('x') };
    const r = await handler({ action: 'edit', edits: [] }, ctx);
    assert.equal(r.reason, 'no_edits');
  });

  test('instagram: файлы нельзя → channel_unsupported', async () => {
    const r = await handler({ action: 'create', spec: { blocks: [{ type: 'paragraph', text: 'x' }] } }, { channel: 'instagram', chatId: '1' });
    assert.equal(r.reason, 'channel_unsupported');
    assert.equal(delivered.length, 0);
  });

  test('неизвестный action → invalid_action', async () => {
    const r = await handler({ action: 'delete' }, ctx);
    assert.equal(r.reason, 'invalid_action');
  });

  test('delivery_failed прокидывается', async () => {
    deliverOk = false;
    const r = await handler({ action: 'create', spec: { blocks: [{ type: 'paragraph', text: 'x' }] } }, ctx);
    assert.equal(r.reason, 'delivery_failed');
  });
});

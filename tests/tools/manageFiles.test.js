'use strict';
// manage_files: сохранение из docStash, права владелец/босс, fallback text.
const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');

let savedArgs = null;
const fileKnowledgeMock = {
  saveFile: async (args) => {
    savedArgs = args;
    if (!String(args.text || '').trim()) return { ok: false, reason: 'empty_text' };
    return { ok: true, file_id: 7, file_name: args.fileName, replaced: false, chunk_count: 3, char_count: args.text.length, visibility: args.visibility === 'private' ? 'private' : 'public', embedded: true };
  },
};
const stash = new Map();
const docStashMock = {
  get: (channel, chatId, name) => {
    const list = stash.get(`${channel}:${chatId}`) || [];
    if (!list.length) return null;
    if (!name || String(name).toLowerCase() === 'last') return list[list.length - 1];
    return list.find((e) => e.fileName.toLowerCase() === String(name).toLowerCase()) || null;
  },
  list: (channel, chatId) => (stash.get(`${channel}:${chatId}`) || []).map((e) => ({ fileName: e.fileName, ts: e.ts })),
};
const files = [];
const mysqlMock = {
  listFiles: async ({ viewer }) => files.filter((f) => viewer.isBoss || f.visibility === 'public' || (f.channel === viewer.channel && f.chat_id === viewer.chatId)),
  findFile: async ({ id, fileName, viewer }) => {
    const visible = await mysqlMock.listFiles({ viewer });
    if (id != null) return visible.find((f) => f.id === id) || null;
    return visible.find((f) => f.file_name === fileName) || null;
  },
  deleteFile: async (id) => {
    const i = files.findIndex((f) => f.id === id);
    if (i < 0) return false;
    files.splice(i, 1);
    return true;
  },
  setFileVisibility: async (id, v) => {
    const f = files.find((x) => x.id === id);
    if (!f) return null;
    f.visibility = v;
    return v;
  },
  renameFile: async (id, name) => {
    const f = files.find((x) => x.id === id);
    if (!f) return false;
    f.file_name = name;
    return true;
  },
};

const orig = Module.prototype.require;
Module.prototype.require = function (id) {
  if (id === '../services/mysql') return mysqlMock;
  if (id === '../services/docStash') return docStashMock;
  if (id === '../services/fileKnowledge') return fileKnowledgeMock;
  return orig.apply(this, arguments);
};
const { handler } = require('../../src/tools/manageFiles');
Module.prototype.require = orig;

const OWNER = { channel: 'whatsapp', chatId: '111', clientName: 'Али', role: 'employee' };
const OTHER = { channel: 'whatsapp', chatId: '222', clientName: 'Берик', role: 'employee' };
const BOSS = { channel: 'whatsapp', chatId: '999', clientName: 'Шеф', role: 'boss' };

describe('manage_files', () => {
  beforeEach(() => {
    savedArgs = null;
    stash.clear();
    files.length = 0;
    files.push(
      { id: 1, channel: 'whatsapp', chat_id: '111', file_name: 'прайс.xlsx', visibility: 'public', owner_name: 'Али', chunk_count: 3, char_count: 100, description: null, created_at: 'x' },
      { id: 2, channel: 'whatsapp', chat_id: '111', file_name: 'личное.txt', visibility: 'private', owner_name: 'Али', chunk_count: 1, char_count: 10, description: null, created_at: 'x' },
    );
  });

  test('save last: текст берётся из стэша, параметры нарезки пробрасываются', async () => {
    stash.set('whatsapp:111', [{ fileName: 'договор.pdf', text: 'текст договора', ts: 1 }]);
    const r = await handler({ action: 'save', chunk_size: 2000, overlap: 200, split: 'heading' }, OWNER);
    assert.equal(r.success, true);
    assert.equal(savedArgs.fileName, 'договор.pdf');
    assert.equal(savedArgs.text, 'текст договора');
    assert.equal(savedArgs.chunkSize, 2000);
    assert.equal(savedArgs.split, 'heading');
    assert.equal(r.visibility, 'public', 'по умолчанию public');
  });

  test('save по имени файла из стэша + visibility private', async () => {
    stash.set('whatsapp:111', [
      { fileName: 'a.txt', text: 'aaa', ts: 1 },
      { fileName: 'b.txt', text: 'bbb', ts: 2 },
    ]);
    const r = await handler({ action: 'save', file_name: 'a.txt', visibility: 'private' }, OWNER);
    assert.equal(r.success, true);
    assert.equal(savedArgs.fileName, 'a.txt');
    assert.equal(savedArgs.visibility, 'private');
  });

  test('save при пустом стэше → not_in_stash со списком доступных', async () => {
    const r = await handler({ action: 'save' }, OWNER);
    assert.equal(r.success, false);
    assert.equal(r.reason, 'not_in_stash');
    assert.ok(Array.isArray(r.available));
  });

  test('save с явным text обходит стэш, но требует настоящее имя', async () => {
    const noName = await handler({ action: 'save', text: 'содержимое' }, OWNER);
    assert.equal(noName.reason, 'file_name_required');
    const r = await handler({ action: 'save', text: 'содержимое', file_name: 'ручной.txt' }, OWNER);
    assert.equal(r.success, true);
    assert.equal(savedArgs.fileName, 'ручной.txt');
  });

  test('list: сотрудник видит public + свои private; чужой private скрыт', async () => {
    const own = await handler({ action: 'list' }, OWNER);
    assert.equal(own.files.length, 2);
    const other = await handler({ action: 'list' }, OTHER);
    assert.deepEqual(other.files.map((f) => f.file_name), ['прайс.xlsx']);
    assert.equal(other.files[0].mine, false);
    const boss = await handler({ action: 'list' }, BOSS);
    assert.equal(boss.files.length, 2, 'босс видит всё');
  });

  test('delete чужого файла сотрудником → отказ; боссом → ок', async () => {
    const refused = await handler({ action: 'delete', file_name: 'прайс.xlsx' }, OTHER);
    assert.equal(refused.success, false);
    assert.equal(refused.reason, 'not_owner');
    const byBoss = await handler({ action: 'delete', file_name: 'прайс.xlsx' }, BOSS);
    assert.equal(byBoss.success, true);
    assert.equal(files.length, 1);
  });

  test('set_visibility владельцем: private → public', async () => {
    const r = await handler({ action: 'set_visibility', file_id: 2, visibility: 'public' }, OWNER);
    assert.equal(r.success, true);
    assert.equal(r.visibility, 'public');
    assert.equal(files.find((f) => f.id === 2).visibility, 'public');
  });

  test('rename владельцем; без new_name → ошибка', async () => {
    const bad = await handler({ action: 'rename', file_id: 1 }, OWNER);
    assert.equal(bad.reason, 'new_name_required');
    const r = await handler({ action: 'rename', file_id: 1, new_name: 'прайс-2025.xlsx' }, OWNER);
    assert.equal(r.success, true);
    assert.equal(files.find((f) => f.id === 1).file_name, 'прайс-2025.xlsx');
  });
});

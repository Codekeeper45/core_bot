'use strict';
// fileKnowledge.searchFiles: ранжирование по dot, fallback на LIKE.
const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');

let enabled = true;
const embeddingsMock = {
  isEnabled: () => enabled,
  embedOne: async () => [1, 0],
  embed: async (texts) => texts.map(() => [1, 0]),
  packFloat32: (v) => v,
  unpackFloat32: (v) => v,
  dot: (a, b) => a.reduce((s, x, i) => s + x * (b[i] || 0), 0),
};
let vectorRows = [];
let keywordRows = [];
let lastVectorArgs = null;
let lastKeywordArgs = null;
const mysqlMock = {
  loadFileChunkVectors: async (args) => { lastVectorArgs = args; return vectorRows; },
  fileKeywordSearch: async (args) => { lastKeywordArgs = args; return keywordRows; },
  replaceFile: async () => ({ id: 1, replaced: false }),
};

const orig = Module.prototype.require;
Module.prototype.require = function (id) {
  if (id === './embeddings') return embeddingsMock;
  if (id === './mysql') return mysqlMock;
  return orig.apply(this, arguments);
};
delete require.cache[require.resolve('../../src/services/fileKnowledge')];
const { searchFiles, saveFile } = require('../../src/services/fileKnowledge');
Module.prototype.require = orig;

const config = require('../../src/config');

describe('fileKnowledge.searchFiles', () => {
  beforeEach(() => {
    enabled = true;
    vectorRows = [];
    keywordRows = [];
    lastVectorArgs = null;
    lastKeywordArgs = null;
  });

  test('семантика: ранжирует по dot, отдаёт файл-источник', async () => {
    vectorRows = [
      { id: 1, file_id: 10, seq: 1, content: 'мимо', embedding: [0, 1], file_name: 'a.txt', owner_name: 'Али', visibility: 'public' },
      { id: 2, file_id: 11, seq: 3, content: 'точное', embedding: [1, 0], file_name: 'b.txt', owner_name: 'Али', visibility: 'public' },
    ];
    const r = await searchFiles({ channel: 'whatsapp', chatId: '1', role: 'employee', query: 'x' });
    assert.equal(r.mode, 'semantic');
    assert.equal(r.results[0].content, 'точное');
    assert.equal(r.results[0].file_name, 'b.txt');
    assert.deepEqual(lastVectorArgs.viewer, { channel: 'whatsapp', chatId: '1', isBoss: false });
  });

  test('семантика пуста → LIKE-fallback (ловит чанки без векторов)', async () => {
    vectorRows = [];
    keywordRows = [{ id: 3, file_id: 12, seq: 1, content: 'дословно', file_name: 'c.txt', owner_name: null, visibility: 'public' }];
    const r = await searchFiles({ channel: 'whatsapp', chatId: '1', role: 'employee', query: 'дословно' });
    assert.equal(r.mode, 'keyword');
    assert.equal(r.results[0].file_name, 'c.txt');
  });

  test('эмбеддинги выключены → сразу LIKE', async () => {
    enabled = false;
    keywordRows = [];
    const r = await searchFiles({ channel: 'whatsapp', chatId: '1', role: 'boss', query: 'x' });
    assert.equal(r.mode, 'keyword');
    assert.equal(lastVectorArgs, null, 'к векторам не ходили');
    assert.equal(lastKeywordArgs.viewer.isBoss, true);
  });

  test('пустой запрос → ok:false', async () => {
    const r = await searchFiles({ channel: 'whatsapp', chatId: '1', query: ' ' });
    assert.equal(r.ok, false);
  });
});

describe('fileKnowledge.saveFile', () => {
  test('эмбеддинги выключены → сохраняет без векторов (embedded=false)', async () => {
    enabled = false;
    const r = await saveFile({ channel: 'whatsapp', chatId: '1', fileName: 'a.txt', text: 'абзац один\n\nабзац два' });
    assert.equal(r.ok, true);
    assert.equal(r.embedded, false);
  });

  test('пустой текст → empty_text; без имени → file_name_required', async () => {
    assert.equal((await saveFile({ channel: 'w', chatId: '1', fileName: 'a', text: '' })).reason, 'empty_text');
    assert.equal((await saveFile({ channel: 'w', chatId: '1', fileName: '', text: 'x' })).reason, 'file_name_required');
  });

  test('эмбеддинги включены → embedded=true, dims/model заполнены', async () => {
    enabled = true;
    let capturedChunks = null;
    mysqlMock.replaceFile = async (args) => { capturedChunks = args.chunks; return { id: 2, replaced: false }; };
    const r = await saveFile({ channel: 'w', chatId: '1', fileName: 'a.txt', text: 'абзац один\n\nабзац два' });
    assert.equal(r.ok, true);
    assert.equal(r.embedded, true);
    assert.ok(capturedChunks.length >= 1);
    assert.equal(capturedChunks[0].dims, config.EMBEDDING_DIMENSIONS);
    assert.equal(capturedChunks[0].model, config.EMBEDDING_MODEL);
  });
});

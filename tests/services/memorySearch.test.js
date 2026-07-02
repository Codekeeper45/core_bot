'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');

// Моки: эмбеддинги детерминированные, mysql отдаёт чанки с готовыми векторами.
const embeddingsMock = {
  isEnabled: () => true,
  embedOne: async () => [1, 0], // вектор запроса
  unpackFloat32: (v) => v,       // в тесте embedding хранится массивом
  dot: (a, b) => a.reduce((s, x, i) => s + x * (b[i] || 0), 0),
};
let loadArgs = null;
const mysqlMock = {
  loadChunkVectors: async (args) => {
    loadArgs = args;
    return [
      { id: 1, channel: 'whatsapp', chat_id: 'boss', content: 'про решётки 120', first_at: '2025-06-01', last_at: '2025-06-01', authors: 'Босс, Бот', msg_count: 10, embedding: [0.7, 0.7] },
      { id: 2, channel: 'whatsapp', chat_id: 'boss', content: 'точное совпадение', first_at: '2025-05-01', last_at: '2025-05-01', authors: 'Босс', msg_count: 10, embedding: [1, 0] },
      { id: 3, channel: 'whatsapp', chat_id: 'boss', content: 'не в тему', first_at: '2025-04-01', last_at: '2025-04-01', authors: 'Бот', msg_count: 10, embedding: [0, 1] },
    ];
  },
};

const orig = Module.prototype.require;
Module.prototype.require = function (id) {
  if (id === './embeddings') return embeddingsMock;
  if (id === './mysql') return mysqlMock;
  return orig.apply(this, arguments);
};
delete require.cache[require.resolve('../../src/services/memorySearch')];
const { semanticRecall } = require('../../src/services/memorySearch');
Module.prototype.require = orig;

describe('semanticRecall', () => {
  test('ранжирует по косинусу (нормированные → dot), даёт даты/авторов', async () => {
    const r = await semanticRecall({ channel: 'whatsapp', chatId: 'boss', query: 'сколько решёток', scope: 'chat', limit: 8 });
    assert.equal(r.ok, true);
    assert.equal(r.results.length, 3);
    // порядок: точное (1.0) → решётки (0.7) → не в тему (0)
    assert.equal(r.results[0].content, 'точное совпадение');
    assert.equal(r.results[1].content, 'про решётки 120');
    assert.equal(r.results[2].content, 'не в тему');
    assert.equal(r.results[0].first_at, '2025-05-01');
    assert.equal(r.results[1].authors, 'Босс, Бот');
  });

  test('viewer пробрасывается в loadChunkVectors (фильтр приватности)', async () => {
    const viewer = { channel: 'whatsapp', chatId: 'emp1', isBoss: false };
    await semanticRecall({ channel: 'whatsapp', chatId: 'emp1', query: 'x', scope: 'all', viewer });
    assert.equal(loadArgs.scope, 'all');
    assert.deepEqual(loadArgs.viewer, viewer);
  });

  test('пустой запрос → ok:false без обращения к БД', async () => {
    const r = await semanticRecall({ channel: 'whatsapp', chatId: 'boss', query: '  ' });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'empty_query');
  });

  test('limit ограничивает выдачу', async () => {
    const r = await semanticRecall({ channel: 'whatsapp', chatId: 'boss', query: 'x', limit: 1 });
    assert.equal(r.results.length, 1);
    assert.equal(r.results[0].content, 'точное совпадение');
  });
});

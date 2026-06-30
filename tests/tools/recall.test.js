'use strict';
const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');

// Управляемые моки семантики и дословного поиска.
let semanticImpl = null;
let lastKeywordArgs = null;
const memorySearchMock = {
  semanticRecall: async (params) => (semanticImpl ? semanticImpl(params) : { ok: false, reason: 'disabled', results: [] }),
};
const mysqlMock = {
  recallSearch: async (params) => {
    lastKeywordArgs = params;
    if (params.query.includes('пусто')) return { messages: [], events: [] };
    return {
      messages: [{ id: 6, channel: 'whatsapp', chat_id: 'boss', role: 'assistant', actor_name: 'Бот', content: 'Айнур скинула 120 решёток', created_at: '2026-06-01 10:01:00' }],
      events: params.kind === 'events' || params.kind === 'all'
        ? [{ id: 9, tool: 'manage_stock', action: 'issue', actor_name: 'Босс', success: 1, summary: 'отгрузка 30', created_at: '2026-06-02 09:00:00' }]
        : undefined,
    };
  },
};

const orig = Module.prototype.require;
Module.prototype.require = function (id) {
  if (id === '../services/mysql') return mysqlMock;
  if (id === '../services/memorySearch') return memorySearchMock;
  return orig.apply(this, arguments);
};
delete require.cache[require.resolve('../../src/tools/recall')];
const { handler } = require('../../src/tools/recall');
Module.prototype.require = orig;

describe('recall', () => {
  beforeEach(() => { semanticImpl = null; lastKeywordArgs = null; });

  test('пустой query → empty_query', async () => {
    const r = await handler({ query: ' ' }, { channel: 'whatsapp', chatId: 'boss' });
    assert.equal(r.success, false);
    assert.equal(r.reason, 'empty_query');
  });

  test('семантика нашла → mode=semantic, фрагменты с периодом и датами', async () => {
    semanticImpl = async () => ({
      ok: true, results: [
        { content: 'про решётки 120', first_at: '2025-06-01', last_at: '2025-06-01', authors: 'Босс, Бот', chat_id: 'boss', score: 0.81 },
      ],
    });
    const r = await handler({ query: 'сколько решёток было летом' }, { channel: 'whatsapp', chatId: 'boss', role: 'boss' });
    assert.equal(r.success, true);
    assert.equal(r.mode, 'semantic');
    assert.equal(r.fragments.length, 1);
    assert.equal(r.fragments[0].period.from, '2025-06-01');
    assert.equal(r.fragments[0].authors, 'Босс, Бот');
    // при найденной семантике по messages дословный поиск не дёргаем
    assert.equal(lastKeywordArgs, null);
  });

  test('семантика выключена → fallback на дословный (keyword), messages заполнены', async () => {
    semanticImpl = async () => ({ ok: false, reason: 'disabled', results: [] });
    const r = await handler({ query: 'решётки' }, { channel: 'whatsapp', chatId: 'boss' });
    assert.equal(r.mode, 'keyword');
    assert.equal(r.messages.length, 1);
    assert.ok(r.messages[0].text.includes('120 решёток'));
  });

  test('kind=all: семантика + события вместе', async () => {
    semanticImpl = async () => ({ ok: true, results: [{ content: 'фрагмент', first_at: '2025-01-01', last_at: '2025-01-02', authors: 'Босс' }] });
    const r = await handler({ query: 'отгрузка', kind: 'all' }, { channel: 'whatsapp', chatId: 'boss', role: 'boss' });
    assert.equal(r.fragments.length, 1);
    assert.equal(r.events.length, 1);
    assert.equal(lastKeywordArgs.kind, 'events'); // фрагменты из семантики, события — из LIKE
  });

  test('сотруднику scope=all сужается до его чата', async () => {
    let seenScope = null;
    semanticImpl = async (p) => { seenScope = p.scope; return { ok: true, results: [] }; };
    const r = await handler({ query: 'x', scope: 'all' }, { channel: 'whatsapp', chatId: 'emp1', role: 'employee' });
    assert.equal(seenScope, 'chat');
    assert.equal(r.scope, 'chat');
  });

  test('боссу scope=all проходит', async () => {
    let seenScope = null;
    semanticImpl = async (p) => { seenScope = p.scope; return { ok: true, results: [] }; };
    await handler({ query: 'x', scope: 'all' }, { channel: 'whatsapp', chatId: 'boss', role: 'boss' });
    assert.equal(seenScope, 'all');
  });

  test('ничего не найдено → found 0 + note', async () => {
    semanticImpl = async () => ({ ok: false, reason: 'disabled', results: [] });
    const r = await handler({ query: 'пусто' }, { channel: 'whatsapp', chatId: 'boss' });
    assert.equal(r.found, 0);
    assert.ok(r.note);
  });
});

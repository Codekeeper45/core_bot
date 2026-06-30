'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { renderChunk, chunkAuthors, authorOf } = require('../../src/utils/chunkText');
const { groupsOf } = require('../../src/services/embeddingWorker');

describe('chunkText: рендер чанка с датами/авторами/временем', () => {
  const msgs = [
    { role: 'user', actor_name: 'Босс', content: 'Сколько решёток?', created_at: '2025-06-01T05:00:00Z' },
    { role: 'assistant', actor_name: 'Бот', content: 'Айнур скинула 120 шт', created_at: '2025-06-01T05:01:00Z' },
  ];

  test('каждая строка: [дата время] Автор: текст', () => {
    const out = renderChunk(msgs).split('\n');
    assert.equal(out.length, 2);
    assert.match(out[0], /^\[2025-06-01 \d{2}:\d{2}\] Босс: Сколько решёток\?$/);
    assert.match(out[1], /^\[2025-06-01 \d{2}:\d{2}\] Бот: Айнур скинула 120 шт$/);
  });

  test('пустые сообщения пропускаются, переносы схлопываются', () => {
    const out = renderChunk([
      { role: 'user', actor_name: 'A', content: '   ', created_at: '2025-01-01T00:00:00Z' },
      { role: 'user', actor_name: 'A', content: 'строка\n\nс  пробелами', created_at: '2025-01-01T00:00:00Z' },
    ]);
    assert.equal(out.split('\n').length, 1);
    assert.match(out, /строка с пробелами$/);
  });

  test('authorOf: фолбэк по роли, chunkAuthors уникальны', () => {
    assert.equal(authorOf({ role: 'user' }), 'Пользователь');
    assert.equal(authorOf({ role: 'assistant' }), 'Бот');
    assert.equal(chunkAuthors(msgs), 'Босс, Бот');
  });
});

describe('groupsOf: нарезка по N, только полные группы', () => {
  test('25 элементов по 10 → 2 полные группы (хвост 5 ждёт)', () => {
    const arr = Array.from({ length: 25 }, (_, i) => i);
    const g = groupsOf(arr, 10);
    assert.equal(g.length, 2);
    assert.deepEqual(g[0], [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    assert.equal(g[1][9], 19);
  });
  test('меньше N → нет групп', () => {
    assert.equal(groupsOf([1, 2, 3], 10).length, 0);
  });
});

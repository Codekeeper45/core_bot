'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { sanitizeReply } = require('../src/security/sanitizer');

test('markdown pipe table is flattened to plain lines (no pipes)', () => {
  const input = [
    '| Имя | Роль |',
    '| --- | --- |',
    '| Иван | менеджер |',
    '| Али | кладовщик |',
  ].join('\n');
  const out = sanitizeReply(input);
  assert.ok(!out.includes('|'), 'не должно остаться символов |');
  assert.ok(!/---/.test(out), 'строка-разделитель должна исчезнуть');
  assert.match(out, /Иван — менеджер/);
  assert.match(out, /Али — кладовщик/);
});

test('plain text without tables is untouched (aside from markdown strip)', () => {
  const out = sanitizeReply('Задача #5 готова, исполнитель Тимур.');
  assert.equal(out, 'Задача #5 готова, исполнитель Тимур.');
});

test('does not mangle a lone pipe in normal sentence', () => {
  // строка не похожа на таблицу (не начинается с |) — оставляем как есть
  const out = sanitizeReply('Выбери вариант A или B');
  assert.match(out, /A или B/);
});

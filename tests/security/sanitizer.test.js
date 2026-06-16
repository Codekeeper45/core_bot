'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { sanitizeReply, sanitizeLog, stripToolMarkup } = require('../../src/security/sanitizer');

describe('sanitizeReply', () => {
  test('masks 16-digit card numbers', () => {
    const r = sanitizeReply('Моя карта 4276123456789012');
    assert.ok(r.includes('4276****9012')); assert.ok(!r.includes('4276123456789012'));
  });
  test('masks 12-digit IIN/BIN', () => {
    const r = sanitizeReply('Мой БИН 123456789012');
    assert.ok(r.includes('1234****9012')); assert.ok(!r.includes('123456789012'));
  });
  test('preserves 5-7 digit amounts', () => {
    assert.ok(sanitizeReply('Оборот 5000000 тенге').includes('5000000'));
  });
  test('preserves short numbers', () => {
    assert.equal(sanitizeReply('Оборот 5000 тенге'), 'Оборот 5000 тенге');
  });
});

describe('stripToolMarkup / sanitizeReply: утечка служебной разметки', () => {
  test('вырезает хвост <｜｜DSML｜｜tool_calls> … (реальный образец)', () => {
    const leak = 'Курс 6.62 тг. <｜｜DSML｜｜tool_calls> <｜｜DSML｜｜invoke name="web_search"> '
      + '<｜｜DSML｜｜parameter name="query" string="true">halyk rub</｜｜DSML｜｜parameter>';
    const r = sanitizeReply(leak);
    assert.ok(!/DSML/.test(r), 'DSML вырезан');
    assert.ok(r.includes('Курс 6.62'), 'полезный текст сохранён');
  });
  test('вырезает [Вызов: …] и строки invoke/parameter', () => {
    const r = sanitizeReply('Передам руководителю. [Вызов: message_boss]');
    assert.ok(!/Вызов/.test(r));
    assert.ok(r.includes('Передам руководителю'));
    const r2 = stripToolMarkup('invoke name="web_search"\nparameter name="q"\nОтвет тут');
    assert.ok(!/invoke|parameter/.test(r2));
    assert.ok(r2.includes('Ответ тут'));
  });
  test('ответ целиком из разметки → пусто (не отправляем)', () => {
    assert.equal(sanitizeReply('<｜｜DSML｜｜tool_calls> <｜｜DSML｜｜invoke name="x">'), '');
  });
  test('обычный текст не портится', () => {
    assert.equal(sanitizeReply('Готово, передал Илье.'), 'Готово, передал Илье.');
  });
});

describe('sanitizeLog', () => {
  test('masks phone numbers', () => {
    const r = sanitizeLog('Lead from +77001234567');
    assert.ok(!r.includes('77001234567'));
  });
  test('masks card numbers', () => {
    const r = sanitizeLog('Card: 4276123456789012');
    assert.ok(!r.includes('4276123456789012'));
  });
});

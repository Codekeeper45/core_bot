'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { sanitizeReply, sanitizeLog } = require('../../src/security/sanitizer');

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

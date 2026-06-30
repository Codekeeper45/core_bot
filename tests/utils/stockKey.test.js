'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { normKey, queryTokens } = require('../../src/utils/stockKey');

describe('normKey', () => {
  test('регистр/пробелы/пунктуация нормализуются', () => {
    assert.equal(normKey('Лоток водоотводный Аквасток Оптима ДН100Н260'),
      'лоток водоотводный аквасток оптима дн100н260');
    assert.equal(normKey('  ДН100 / Н260  '), 'дн100 н260');
  });
  test('ё → е', () => {
    assert.equal(normKey('Решётка чугунная'), 'решетка чугунная');
  });
  test('ДН/Н токен стабилен и одинаков при разном написании регистра', () => {
    assert.equal(normKey('дн100н260'), normKey('ДН100Н260'));
  });
  test('пусто/мусор', () => {
    assert.equal(normKey(''), '');
    assert.equal(normKey('—  ·  '), '');
  });
});

describe('queryTokens', () => {
  test('бьёт запрос на токены для AND-поиска', () => {
    assert.deepEqual(queryTokens('Аквасток ДН200'), ['аквасток', 'дн200']);
    assert.deepEqual(queryTokens('   '), []);
  });
});

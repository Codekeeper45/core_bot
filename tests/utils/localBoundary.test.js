'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { localBoundaryToUtc } = require('../../src/utils/localTime');

// Время компании UTC+5 (offset 300). Местная граница → абсолютный UTC.
describe('localBoundaryToUtc (UTC+5)', () => {
  test('дата, начало периода → 00:00 местного = −5ч UTC', () => {
    const d = localBoundaryToUtc('2025-06-01', false, 300);
    assert.equal(d.toISOString(), '2025-05-31T19:00:00.000Z');
  });

  test('дата, конец периода → 23:59:59.999 местного', () => {
    const d = localBoundaryToUtc('2025-06-01', true, 300);
    assert.equal(d.toISOString(), '2025-06-01T18:59:59.999Z');
  });

  test('дата+время трактуется как местное', () => {
    const d = localBoundaryToUtc('2025-06-01 12:30', false, 300);
    assert.equal(d.toISOString(), '2025-06-01T07:30:00.000Z');
  });

  test('дата+время, конец → секунды .59.999', () => {
    const d = localBoundaryToUtc('2025-06-01 12:30', true, 300);
    assert.equal(d.toISOString(), '2025-06-01T07:30:59.999Z');
  });

  test('явный UTC (Z) трактуется как абсолютный', () => {
    const d = localBoundaryToUtc('2025-06-01T00:00:00Z', false, 300);
    assert.equal(d.toISOString(), '2025-06-01T00:00:00.000Z');
  });

  test('мусор → null', () => {
    assert.equal(localBoundaryToUtc('завтра', false, 300), null);
    assert.equal(localBoundaryToUtc('', false, 300), null);
    assert.equal(localBoundaryToUtc(null, false, 300), null);
  });
});

'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { parseNbkRates } = require('../../src/tools/exchangeRate');

const XML = `<?xml version="1.0"?><rss><channel>
  <item><title>AUD</title><pubDate>16.06.2026</pubDate><description>347.5</description><quant>1</quant></item>
  <item><title>RUB</title><pubDate>16.06.2026</pubDate><description>6.78</description><quant>1</quant></item>
  <item><title>AMD</title><pubDate>16.06.2026</pubDate><description>123.4</description><quant>100</quant></item>
</channel></rss>`;

describe('parseNbkRates (НБ РК)', () => {
  test('RUB → курс и дата', () => {
    const r = parseNbkRates(XML, 'RUB');
    assert.equal(r.code, 'RUB');
    assert.equal(r.rate, 6.78);
    assert.equal(r.date, '16.06.2026');
  });
  test('регистронезависимо (rub)', () => {
    assert.equal(parseNbkRates(XML, 'rub').rate, 6.78);
  });
  test('quant>1 нормализуется к 1 единице', () => {
    const r = parseNbkRates(XML, 'AMD');
    assert.equal(r.rate, 1.234); // 123.4 / 100
  });
  test('неизвестная валюта → null', () => {
    assert.equal(parseNbkRates(XML, 'XYZ'), null);
  });
  test('мусор/пусто → null без исключения', () => {
    assert.equal(parseNbkRates('', 'RUB'), null);
    assert.equal(parseNbkRates('<rss></rss>', 'RUB'), null);
  });
});

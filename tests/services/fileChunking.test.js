'use strict';
// Чистая нарезка текста для базы знаний (fileKnowledge.chunkText) — без моков.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { chunkText, clampChunkParams } = require('../../src/services/fileKnowledge');

describe('clampChunkParams', () => {
  test('границы: chunk_size 100→500, 9000→4000; overlap ≤ size/3 и ≤600', () => {
    assert.equal(clampChunkParams({ chunkSize: 100 }).chunkSize, 500);
    assert.equal(clampChunkParams({ chunkSize: 9000 }).chunkSize, 4000);
    assert.equal(clampChunkParams({ chunkSize: 900, overlap: 9000 }).overlap, 300);
    assert.equal(clampChunkParams({ chunkSize: 4000, overlap: 9000 }).overlap, 600);
    assert.equal(clampChunkParams({ split: 'nope' }).split, 'paragraph');
  });
});

describe('chunkText', () => {
  test('пустой текст → []', () => {
    assert.deepEqual(chunkText(''), []);
    assert.deepEqual(chunkText('   \n  '), []);
  });

  test('fixed: окна с перекрытием, всё содержимое покрыто', () => {
    const text = 'а'.repeat(2500);
    const chunks = chunkText(text, { chunkSize: 1000, overlap: 200, split: 'fixed' });
    assert.equal(chunks.length, Math.ceil((2500 - 200) / 800) + 0); // шаг 800
    assert.ok(chunks.every((c) => c.length <= 1000));
    assert.equal(chunks[0].length, 1000);
  });

  test('paragraph: абзацы пакуются до chunk_size, порядок сохранён', () => {
    const paras = Array.from({ length: 10 }, (_, i) => `Абзац номер ${i} — ${'текст '.repeat(30)}`);
    const chunks = chunkText(paras.join('\n\n'), { chunkSize: 600, overlap: 0, split: 'paragraph' });
    assert.ok(chunks.length > 1);
    assert.ok(chunks[0].includes('Абзац номер 0'));
    assert.ok(chunks[chunks.length - 1].includes('Абзац номер 9'));
    assert.ok(chunks.every((c) => c.length <= 600));
  });

  test('paragraph: overlap добавляет хвост предыдущего чанка', () => {
    const paras = ['первый '.repeat(60), 'второй '.repeat(60)];
    const chunks = chunkText(paras.join('\n\n'), { chunkSize: 500, overlap: 100, split: 'paragraph' });
    assert.ok(chunks.length >= 2);
    assert.ok(chunks[1].startsWith('…'), 'второй чанк должен начинаться с хвоста первого');
  });

  test('paragraph: негабаритный абзац дорезается, ничего не теряется', () => {
    const huge = 'слово '.repeat(400); // ~2400 символов
    const chunks = chunkText(huge, { chunkSize: 800, overlap: 0, split: 'paragraph' });
    assert.ok(chunks.length >= 3);
    assert.ok(chunks.every((c) => c.length <= 800));
  });

  test('heading: сплит по [Лист: …] и markdown-заголовкам', () => {
    const text = [
      '[Лист: Прайс]', 'строка,цена', '1101,18000',
      '[Лист: Остатки]', 'товар,кол-во', 'лоток,5',
    ].join('\n');
    const chunks = chunkText(text, { chunkSize: 500, overlap: 0, split: 'heading' });
    assert.equal(chunks.length, 1); // оба блока влезли в один чанк — но границы не потерялись
    const big = chunkText(text.replace(/лоток,5/, 'лоток,5\n' + 'x'.repeat(600)), { chunkSize: 500, overlap: 0, split: 'heading' });
    assert.ok(big.length >= 2);
    assert.ok(big[0].includes('[Лист: Прайс]'));
  });

  test('дефолты дают адекватную нарезку связного текста', () => {
    const text = Array.from({ length: 20 }, (_, i) => `Раздел ${i}. ${'предложение '.repeat(20)}`).join('\n\n');
    const chunks = chunkText(text);
    assert.ok(chunks.length >= 2);
    assert.ok(chunks.every((c) => c.length <= 4000));
  });
});

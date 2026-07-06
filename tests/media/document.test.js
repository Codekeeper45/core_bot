'use strict';
// processDocument: развязка приёма от лимита контекста. Полный текст → буфер,
// в контекст LLM → только превью. Большие таблицы больше НЕ отклоняются.
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');
const config = require('../../src/config');

let stashed = null;
const mysqlMock = { checkDailyCount: async () => false, incrementDailyCount: async () => {} };
const telegramMock = { downloadFile: async () => ({ buffer: Buffer.from(BIG_TEXT, 'utf-8') }) };
const docStashMock = { put: (channel, chatId, entry) => { stashed = entry; } };

let BIG_TEXT = '';

const orig = Module.prototype.require;
Module.prototype.require = function (id) {
  if (id === '../services/mysql') return mysqlMock;
  if (id === '../channels/telegram') return telegramMock;
  if (id === '../services/docStash') return docStashMock;
  return orig.apply(this, arguments);
};
const { processDocument } = require('../../src/media/document');
// require НЕ восстанавливаем: downloadDocumentBuffer/docStash берутся лениво в рантайме.

function normalized(text) {
  BIG_TEXT = text;
  return {
    channel: 'telegram', chat_id: '111',
    document_family: 'text', document_file_name: 'big-table.csv',
    document_file_id: 'FID', message: '',
  };
}

beforeEach(() => { stashed = null; });

test('большой текст (>20k) НЕ отклоняется; полный текст уходит в буфер', async () => {
  const text = 'строка данных;значение\n'.repeat(2000); // ~44k символов
  const r = await processDocument(normalized(text));
  assert.ok(!r.error, 'не должно быть ошибки лимита');
  assert.ok(r.text, 'есть результат для контекста');
  assert.equal(stashed.text.length, text.length, 'в буфер попал ПОЛНЫЙ текст');
  assert.equal(stashed.fileName, 'big-table.csv');
});

test('в контекст LLM уходит только превью + метка про буфер', async () => {
  const text = 'A'.repeat(40000);
  const r = await processDocument(normalized(text));
  // Результат заметно короче полного текста (превью ~DOC_INLINE_PREVIEW_CHARS).
  assert.ok(r.text.length < text.length, 'inline-результат усечён');
  assert.ok(r.text.length < config.DOC_INLINE_PREVIEW_CHARS + 1000);
  assert.match(r.text, /полный текст в буфере/);
  assert.match(r.text, /показан фрагмент/);
  assert.match(r.text, /\[ИЗ ДОКУМЕНТА: big-table\.csv\]/);
});

test('небольшой файл: показывается целиком, без пометки об обрезке', async () => {
  const text = 'короткий документ на пару строк';
  const r = await processDocument(normalized(text));
  assert.ok(r.text.includes(text), 'весь текст виден');
  assert.doesNotMatch(r.text, /показан фрагмент/);
  assert.equal(stashed.text, text);
});

test('огромный файл (>DOC_KB_CHAR_LIMIT) усекается в буфере с пометкой', async () => {
  const text = 'X'.repeat(config.DOC_KB_CHAR_LIMIT + 50000);
  const r = await processDocument(normalized(text));
  assert.equal(stashed.text.length, config.DOC_KB_CHAR_LIMIT, 'буфер обрезан до кэпа');
  assert.match(r.text, /файл огромный/);
});

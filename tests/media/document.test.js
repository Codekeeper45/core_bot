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

// ─── OLE .doc / RTF / ZIP: не бинарный dump, а читаемый русский текст ───
const fs = require('fs');
const path = require('path');
const FIXTURE_ZIP = [
  path.join('/var/home/emir/Загрузки', 'test_rtf_and_doc_large (1).zip'),
  path.join('/var/home/emir/Загрузки', 'test_rtf_and_doc_large.zip'),
].find((p) => fs.existsSync(p));

test('OLE .doc: извлекается читаемый текст, без бинарного dump', async () => {
  if (!FIXTURE_ZIP) { console.log('skip: нет fixture zip'); return; }
  const JSZip = require('jszip');
  const zip = await JSZip.loadAsync(fs.readFileSync(FIXTURE_ZIP));
  const entry = zip.file('test_document.doc');
  assert.ok(entry, 'в fixture есть test_document.doc');
  const buf = Buffer.from(await entry.async('arraybuffer'));
  telegramMock.downloadFile = async () => ({ buffer: buf });
  const r = await processDocument({
    channel: 'telegram', chat_id: '111',
    document_family: 'doc', document_file_name: 'test_document.doc',
    document_file_id: 'DOC', message: '',
  });
  assert.ok(!r.error, r.error);
  assert.match(r.text, /Большой тестовый документ/);
  assert.match(r.text, /Алматы/);
  assert.doesNotMatch(r.text, /Root Entry|MSWordDoc|ÐÏ/);
});

test('RTF: извлекается читаемый кириллический текст', async () => {
  if (!FIXTURE_ZIP) { console.log('skip: нет fixture zip'); return; }
  const JSZip = require('jszip');
  const zip = await JSZip.loadAsync(fs.readFileSync(FIXTURE_ZIP));
  const entry = zip.file('test_document.rtf');
  assert.ok(entry, 'в fixture есть test_document.rtf');
  const buf = Buffer.from(await entry.async('arraybuffer'));
  telegramMock.downloadFile = async () => ({ buffer: buf });
  const r = await processDocument({
    channel: 'telegram', chat_id: '111',
    document_family: 'doc', document_file_name: 'test_document.rtf',
    document_file_id: 'RTF', message: '',
  });
  assert.ok(!r.error, r.error);
  assert.match(r.text, /Большой тестовый документ/);
  assert.match(r.text, /Алматы/);
});

test('ZIP с .doc+.rtf: оба файла читаются, без OLE-мусора', async () => {
  if (!FIXTURE_ZIP) { console.log('skip: нет fixture zip'); return; }
  const buf = fs.readFileSync(FIXTURE_ZIP);
  telegramMock.downloadFile = async () => ({ buffer: buf });
  const r = await processDocument({
    channel: 'telegram', chat_id: '111',
    document_family: 'archive', document_file_name: 'test_rtf_and_doc_large.zip',
    document_file_id: 'ZIP', message: '',
  });
  assert.ok(!r.error, r.error);
  assert.match(r.text, /test_document\.doc/);
  assert.match(r.text, /Большой тестовый документ/);
  assert.doesNotMatch(r.text, /Root Entry|MSWordDoc/);
  // полный текст в stash содержит оба файла
  assert.match(stashed.text, /test_document\.rtf/);
  assert.match(stashed.text, /Большой тестовый документ/);
});

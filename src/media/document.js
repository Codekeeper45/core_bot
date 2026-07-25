'use strict';
const { checkDailyCount, incrementDailyCount } = require('../services/mysql');
const tgClient = require('../channels/telegram');
const config = require('../config');

const FALLBACK_MESSAGES = {
  doc_daily_limit: 'Сегодня можно отправить не больше 10 документов. Попробуйте продолжить завтра.',
  doc_char_limit: 'Документ слишком большой даже для базы знаний. Пришлите его частями.',
  doc_unsupported: 'Этот формат файла пока не поддерживается. Можно отправить PDF, DOC/DOCX/ODT/RTF, XLS/XLSX/ODS, TXT/CSV, MD/JSON/XML/YAML, PPT/PPTX, архивы (ZIP/RAR), email (EML).',
  doc_parse_failed: (name) => `Не удалось обработать файл ${name}. Попробуйте отправить его ещё раз или в PDF.`,
};

async function checkDailyDocLimit(channel, chatId) {
  return checkDailyCount(channel, chatId, 'document', config.DAILY_DOC_LIMIT);
}

async function incrementDailyDocCount(channel, chatId) {
  return incrementDailyCount(channel, chatId, 'document');
}

async function downloadDocumentBuffer(normalized) {
  const { channel, document_source_url, document_file_id, baileys_media_obj } = normalized;

  if (channel === 'telegram') {
    const { buffer } = await tgClient.downloadFile(document_file_id);
    return buffer;
  } else if (baileys_media_obj) {
    // WhatsApp Baileys
    const baileys = require('../services/baileys');
    return baileys.downloadMedia(baileys_media_obj, 'document');
  } else if (channel === 'instagram' && document_source_url) {
    const wazzup = require('../services/wazzup');
    const { buffer } = await wazzup.downloadContent(document_source_url);
    return buffer;
  } else if (document_source_url) {
    const res = await fetch(document_source_url);
    if (!res.ok) throw new Error(`Download failed: ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }
  throw new Error('No document source available');
}

// Определяем family файла по имени (без MIME — у файлов внутри ZIP нет MIME-типов)
function familyByName(name) {
  const ext = (name.split('.').pop() || '').toLowerCase();
  if (ext === 'pdf') return 'pdf';
  if (['doc', 'docx', 'odt', 'rtf'].includes(ext)) return 'doc';
  if (['xls', 'xlsx', 'ods', 'ots', 'numbers', 'csv'].includes(ext)) return 'spreadsheet';
  if (['txt', 'md', 'json', 'xml', 'yaml', 'yml', 'log', 'ini', 'html', 'htm', 'js', 'ts', 'py', 'sh', 'sql', 'tsv'].includes(ext)) return 'text';
  if (['ppt', 'pptx', 'odp', 'key'].includes(ext)) return 'presentation';
  if (['eml', 'msg'].includes(ext)) return 'email';
  return null; // пропускаем бинарники (изображения, медиа и т.д.)
}

async function parseDocumentBuffer(buffer, family, fileName) {
  switch (family) {
    case 'pdf': {
      const pdfParse = require('pdf-parse');
      const data = await pdfParse(buffer);
      return data.text || '';
    }
    case 'doc': {
      // mammoth читает docx нативно. Для .doc/.odt/.rtf побеждем ошибку и вернём подсказку
      try {
        const mammoth = require('mammoth');
        const result = await mammoth.extractRawText({ buffer });
        if (result.value) return result.value;
      } catch (_) {}
      // Для старых .doc/RTF попытаемся вычитать текст как latin1 (RTF — ASCII-переходы)
      const raw = buffer.toString('latin1').replace(/\\[a-z]+\d* ?|[{}]/g, ' ').replace(/\s+/g, ' ').trim();
      return raw.length > 20 ? raw : `[Формат файла: ${fileName}] Не удалось извлечь текст. Конвертируйте в PDF.`;
    }
    case 'text': {
      return buffer.toString('utf-8');
    }
    case 'spreadsheet': {
      const XLSX = require('xlsx');
      const workbook = XLSX.read(buffer, { type: 'buffer' });
      return workbook.SheetNames.map(name => {
        const sheet = workbook.Sheets[name];
        return `[Лист: ${name}]\n` + XLSX.utils.sheet_to_csv(sheet);
      }).join('\n\n');
    }
    case 'presentation': {
      // Попытаемся читать pptx через xlsx (ZIP+XML)
      try {
        const XLSX = require('xlsx');
        const wb = XLSX.read(buffer, { type: 'buffer' });
        if (wb.SheetNames.length) {
          return wb.SheetNames.map(n => `[Слайд: ${n}]\n` + XLSX.utils.sheet_to_csv(wb.Sheets[n])).join('\n\n');
        }
      } catch (_) {}
      return `[Файл презентации: ${fileName}] Содержимое не удалось извлечь. Конвертируйте в PDF.`;
    }
    case 'archive': {
      // Распаковываем ZIP и читаем каждый файл внутри
      console.log(`[Doc] Обработка ZIP-архива: ${fileName}, размер: ${buffer.length} байт`);
      try {
        const JSZip = require('jszip');
        const zip = await JSZip.loadAsync(buffer);
        const MAX_FILES = 30;
        const MAX_FILE_BYTES = 5 * 1024 * 1024;
        const MAX_TOTAL_CHARS = 80000;

        const entries = Object.values(zip.files).filter(f => !f.dir);
        console.log(`[Doc] ZIP содержит ${entries.length} файлов`);
        const lines = [`[АРХИВ: ${fileName}] Файлов: ${entries.length}`];
        let totalChars = 0;

        for (const entry of entries.slice(0, MAX_FILES)) {
          const entryName = entry.name;
          const entryFamily = familyByName(entryName);

          lines.push(`\n--- ${entryName} ---`);

          if (!entryFamily) {
            lines.push(`(бинарный файл, чтение не поддерживается)`);
            continue;
          }

          try {
            const entryBuf = Buffer.from(await entry.async('arraybuffer'));
            if (entryBuf.length > MAX_FILE_BYTES) {
              lines.push(`(файл слишком большой: ${Math.round(entryBuf.length / 1024)} КБ — пропущен)`);
              continue;
            }
            let text = await parseDocumentBuffer(entryBuf, entryFamily, entryName);
            if (!text) { lines.push(`(не удалось прочитать)`); continue; }
            const remaining = MAX_TOTAL_CHARS - totalChars;
            if (remaining <= 0) { lines.push(`(лимит вывода достигнут)`); break; }
            if (text.length > remaining) { text = text.slice(0, remaining) + '\n…(обрезано)'; }
            lines.push(text);
            totalChars += text.length;
          } catch (err) {
            lines.push(`(ошибка чтения: ${err.message})`);
          }
        }

        if (entries.length > MAX_FILES) {
          lines.push(`\n…ещё ${entries.length - MAX_FILES} файлов не показаны (лимит ${MAX_FILES})`);
        }

        return lines.join('\n');
      } catch (err) {
        return `[Архив: ${fileName}] Не удалось распаковать ZIP: ${err.message}. Возможно, архив повреждён или зашифрован.`;
      }
    }
    case 'email': {
      // Читаем EML как текст (RFC-822 — plain text)
      const raw = buffer.toString('utf-8');
      return raw.slice(0, 50000);
    }
    default:
      return null;
  }
}


async function processDocument(normalized) {
  const { channel, chat_id, document_family, document_file_name, message } = normalized;

  if (document_family === 'unsupported') {
    return { error: FALLBACK_MESSAGES.doc_unsupported };
  }

  const limitExceeded = await checkDailyDocLimit(channel, chat_id);
  if (limitExceeded) {
    return { error: FALLBACK_MESSAGES.doc_daily_limit };
  }

  let buffer;
  try {
    buffer = await downloadDocumentBuffer(normalized);
  } catch (err) {
    console.error('[Doc] Download error:', err.message);
    return { error: FALLBACK_MESSAGES.doc_parse_failed(document_file_name) };
  }

  await incrementDailyDocCount(channel, chat_id);

  let parsedText;
  try {
    parsedText = await parseDocumentBuffer(buffer, document_family, document_file_name);
  } catch (err) {
    console.error('[Doc] Parse error:', err.message);
    return { error: FALLBACK_MESSAGES.doc_parse_failed(document_file_name) };
  }

  if (!parsedText) {
    return { error: FALLBACK_MESSAGES.doc_parse_failed(document_file_name) };
  }

  // Полный текст держим в буфере (в пределах DOC_KB_CHAR_LIMIT) — чтобы в базу
  // знаний влезали крупные таблицы/прайсы целиком, а не только первые 20k.
  const fullText = parsedText.length > config.DOC_KB_CHAR_LIMIT
    ? parsedText.slice(0, config.DOC_KB_CHAR_LIMIT)
    : parsedText;
  const stashTruncated = parsedText.length > config.DOC_KB_CHAR_LIMIT;

  // Кладём ПОЛНЫЙ текст в стэш: инструмент manage_files (база знаний) сохранит
  // файл в векторное хранилище, не гоняя текст через аргументы LLM.
  try {
    require('../services/docStash').put(channel, chat_id, { fileName: document_file_name, text: fullText });
  } catch (err) { console.error('[Doc] docStash:', err.message); }

  // Настоящие Office-файлы (.docx/.xlsx — это zip, сигнатура «PK») дополнительно
  // держим бинарником: manage_document правит договор на месте, а
  // financial_analysis считает по исходной таблице 1С, а не по лоссовому тексту.
  // Исключаем настоящие ZIP-архивы (family=archive) — им binary stash не нужен.
  try {
    if (document_family !== 'archive' && buffer && buffer.length >= 2 && buffer[0] === 0x50 && buffer[1] === 0x4b) {
      require('../services/docBinaryStash').put(channel, chat_id, {
        fileName: document_file_name, buffer, mimetype: normalized.document_mime_type || null,
      });
    }
  } catch (err) { console.error('[Doc] docBinaryStash:', err.message); }

  // В контекст модели отдаём только превью: сырой CSV/большой документ не должен
  // раздувать окно. Полный текст остаётся в буфере для сохранения.
  const preview = fullText.length > config.DOC_INLINE_PREVIEW_CHARS
    ? fullText.slice(0, config.DOC_INLINE_PREVIEW_CHARS)
    : fullText;
  const shortened = preview.length < fullText.length;
  const lineCount = (fullText.match(/\n/g) || []).length + 1;
  const caption = message || '';

  const header = `[ИЗ ДОКУМЕНТА: ${document_file_name}] (${fullText.length} симв., ~${lineCount} строк`
    + `${stashTruncated ? '; файл огромный — в буфер взят фрагмент' : ''}; `
    + `полный текст в буфере — чтобы сохранить в базу знаний, вызови manage_files save)`;
  const footer = shortened ? '\n\n…(показан фрагмент; полный текст доступен для сохранения в базу знаний)' : '';
  const result = `${header}\n\ncaption: ${caption || 'нет'}\n\n${preview}${footer}`;
  return { text: result };
}

module.exports = { processDocument };

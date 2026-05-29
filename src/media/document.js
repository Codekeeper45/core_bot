'use strict';
const { checkDailyCount, incrementDailyCount } = require('../services/mysql');
const tgClient = require('../channels/telegram');
const config = require('../config');

const FALLBACK_MESSAGES = {
  doc_daily_limit: 'Сегодня можно отправить не больше 10 документов. Попробуйте продолжить завтра.',
  doc_char_limit: 'Документ слишком большой для обработки. Максимум — 20000 символов текста в одном файле.',
  doc_unsupported: 'Этот формат файла пока не поддерживается. Можно отправить PDF, DOC/DOCX или TXT.',
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

async function parseDocumentBuffer(buffer, family, fileName) {
  switch (family) {
    case 'pdf': {
      const pdfParse = require('pdf-parse');
      const data = await pdfParse(buffer);
      return data.text || '';
    }
    case 'doc': {
      const mammoth = require('mammoth');
      const result = await mammoth.extractRawText({ buffer });
      return result.value || '';
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
      return `[Файл презентации: ${fileName}] Содержимое не удалось извлечь. Конвертируйте в PDF.`;
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

  if (parsedText.length > config.DOCUMENT_CHAR_LIMIT) {
    return { error: FALLBACK_MESSAGES.doc_char_limit };
  }

  const caption = message || '';
  const result = `[ИЗ ДОКУМЕНТА: ${document_file_name}]\n\ncaption: ${caption || 'нет'}\n\n${parsedText}`;
  return { text: result };
}

module.exports = { processDocument };

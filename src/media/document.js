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

function isOleCompound(buffer) {
  // CFB / OLE2: D0 CF 11 E0 A1 B1 1A E1 — Word 97–2003 .doc
  return Buffer.isBuffer(buffer) && buffer.length >= 8
    && buffer[0] === 0xd0 && buffer[1] === 0xcf
    && buffer[2] === 0x11 && buffer[3] === 0xe0;
}

function isZipContainer(buffer) {
  return Buffer.isBuffer(buffer) && buffer.length >= 2
    && buffer[0] === 0x50 && buffer[1] === 0x4b; // "PK" — docx/xlsx/odt/zip
}

function isRtfBuffer(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 5) return false;
  const head = buffer.slice(0, 16).toString('latin1').replace(/^\uFEFF/, '');
  return head.startsWith('{\\rtf');
}

// Текст «живой»? Бинарный latin1-dump .doc даёт кучу \x00/\xff — в LLM такое нельзя.
function isMostlyReadableText(text) {
  if (!text || typeof text !== 'string') return false;
  const s = text.replace(/\s+/g, '');
  if (s.length < 8) return false;
  let printable = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    // буквы/цифры/пунктуация Unicode + кириллица
    if (c >= 0x20 || c === 0x09 || c === 0x0a || c === 0x0d) {
      if (c !== 0xfffd) printable++;
    }
  }
  // доля «нормальных» символов после удаления пробелов
  const ratio = printable / s.length;
  // и хотя бы немного букв (латиница/кириллица)
  const letters = (s.match(/[A-Za-zА-Яа-яЁё]/g) || []).length;
  return ratio >= 0.85 && letters >= 5;
}

function failExtract(fileName, hint) {
  return `[Формат файла: ${fileName}] ${hint || 'Не удалось извлечь текст. Конвертируйте в PDF или DOCX.'}`;
}

// RTF: убираем таблицы шрифтов/стилей, декодируем \uN и \'hh. Без сырого dump бинарника.
function extractRtfText(buffer) {
  let s = buffer.toString('latin1');
  if (!s.includes('\\rtf')) return null;

  // Игнорируемые группы {\* ... }
  s = stripRtfGroups(s, (inner) => inner.startsWith('\\*'));
  // Служебные destination-группы
  for (const name of [
    'fonttbl', 'colortbl', 'stylesheet', 'info', 'filetbl',
    'listtable', 'listoverridetable', 'rsidtbl', 'generator',
    'latentstyles', 'xmlnstbl', 'pgptbl',
  ]) {
    s = stripRtfNamedGroup(s, name);
  }

  // \uN + опциональный fallback-байт \'hh (часто \'3f = ?)
  s = s.replace(/\\u(-?\d+)\s*(?:\\'[0-9a-fA-F]{2})?/g, (_, n) => {
    let code = Number(n);
    if (!Number.isFinite(code)) return '';
    if (code < 0) code += 65536;
    try { return String.fromCodePoint(code); } catch { return ''; }
  });
  // hex-байты в кодовой странице документа (часто cp1251) — после \u уже не критично
  s = s.replace(/\\'([0-9a-fA-F]{2})/g, (_, h) => {
    const b = parseInt(h, 16);
    if (!Number.isFinite(b)) return '';
    // cp1251-friendly: оставляем байт, декодируем пачкой ниже при необходимости
    return String.fromCharCode(b);
  });
  s = s.replace(/\\par[d]?\b/gi, '\n');
  s = s.replace(/\\line\b/gi, '\n');
  s = s.replace(/\\tab\b/gi, '\t');
  s = s.replace(/\\emdash\b/gi, '—');
  s = s.replace(/\\endash\b/gi, '–');
  s = s.replace(/\\bullet\b/gi, '•');
  s = s.replace(/\\lquote\b/gi, '‘');
  s = s.replace(/\\rquote\b/gi, '’');
  s = s.replace(/\\ldblquote\b/gi, '«');
  s = s.replace(/\\rdblquote\b/gi, '»');
  s = s.replace(/\\([{}\\])/g, '$1');
  s = s.replace(/\\[a-zA-Z]+\-?\d* ?/g, '');
  s = s.replace(/[{}]/g, '');
  s = s.replace(/[^\S\n]+/g, ' ');
  s = s.replace(/\n[ \t]+/g, '\n');
  s = s.replace(/\n{3,}/g, '\n\n').trim();

  // Если кириллицы нет, а «кракозябры» есть — попробуем интерпретировать как cp1251
  if (s && !/[А-Яа-яЁё]/.test(s) && /[\x80-\xff]/.test(s)) {
    try {
      const td = new TextDecoder('windows-1251');
      const recoded = td.decode(Buffer.from(s, 'latin1'));
      if (/[А-Яа-яЁё]/.test(recoded)) s = recoded;
    } catch (_) {}
  }
  return s;
}

function stripRtfNamedGroup(input, name) {
  const token = `{\\${name}`;
  let s = input;
  let idx;
  while ((idx = s.indexOf(token)) !== -1) {
    // token может быть `{\fonttbl` или `{\stylesheet` — дальше пробел/бэкслеш/}
    const next = s[idx + token.length];
    if (next && /[a-zA-Z0-9]/.test(next)) {
      // ложное совпадение префикса (например fonttblx) — сдвигаемся
      const cont = s.indexOf(token, idx + 1);
      if (cont === -1) break;
      idx = cont;
      continue;
    }
    let depth = 0;
    let end = -1;
    for (let j = idx; j < s.length; j++) {
      if (s[j] === '{') depth++;
      else if (s[j] === '}') {
        depth--;
        if (depth === 0) { end = j; break; }
      }
    }
    if (end === -1) break;
    s = s.slice(0, idx) + s.slice(end + 1);
  }
  return s;
}

function stripRtfGroups(input, predicate) {
  // predicate(innerWithoutBrace) — удалить группу если true
  let s = input;
  let i = 0;
  let out = '';
  while (i < s.length) {
    if (s[i] === '{') {
      let depth = 0;
      let end = -1;
      for (let j = i; j < s.length; j++) {
        if (s[j] === '{') depth++;
        else if (s[j] === '}') {
          depth--;
          if (depth === 0) { end = j; break; }
        }
      }
      if (end === -1) { out += s.slice(i); break; }
      const inner = s.slice(i + 1, end);
      if (predicate(inner)) {
        i = end + 1;
        continue;
      }
      // не удаляем — но всё равно нужно пройти внутрь; упростим: оставим как есть и идём дальше посимвольно
      out += s[i];
      i++;
      continue;
    }
    out += s[i];
    i++;
  }
  return out;
}

async function extractOleDocText(buffer, fileName) {
  // 1) word-extractor (pure JS, CFB/OLE) — основной путь для .doc
  try {
    const WordExtractor = require('word-extractor');
    const extractor = new WordExtractor();
    const doc = await extractor.extract(buffer);
    const parts = [];
    if (typeof doc.getBody === 'function') {
      const body = String(doc.getBody() || '').trim();
      if (body) parts.push(body);
    }
    if (typeof doc.getHeaders === 'function') {
      const h = String(doc.getHeaders({ includeFooters: false }) || '').trim();
      if (h) parts.push(`[Колонтитулы]\n${h}`);
    }
    if (typeof doc.getFootnotes === 'function') {
      const f = String(doc.getFootnotes() || '').trim();
      if (f) parts.push(`[Сноски]\n${f}`);
    }
    const text = parts.join('\n\n').trim();
    if (isMostlyReadableText(text)) {
      console.log(`[Doc] OLE .doc через word-extractor: ${fileName}, ${text.length} симв.`);
      return text;
    }
  } catch (err) {
    console.warn(`[Doc] word-extractor failed (${fileName}):`, err.message);
  }

  // 2) antiword CLI, если есть в контейнере (бонус, не обязателен)
  try {
    const { execFileSync } = require('child_process');
    const fs = require('fs');
    const os = require('os');
    const path = require('path');
    const tmp = path.join(os.tmpdir(), `neodrain-doc-${Date.now()}-${Math.random().toString(36).slice(2)}.doc`);
    fs.writeFileSync(tmp, buffer);
    try {
      const out = execFileSync('antiword', ['-m', 'UTF-8.txt', tmp], {
        encoding: 'utf8',
        maxBuffer: 8 * 1024 * 1024,
        timeout: 15000,
      });
      const text = String(out || '').trim();
      if (isMostlyReadableText(text)) {
        console.log(`[Doc] OLE .doc через antiword: ${fileName}, ${text.length} симв.`);
        return text;
      }
    } finally {
      try { fs.unlinkSync(tmp); } catch (_) {}
    }
  } catch (_) {}

  return null;
}

async function extractDocFamilyText(buffer, fileName) {
  const ext = (fileName.split('.').pop() || '').toLowerCase();

  // 1) RTF — по magic или расширению
  if (isRtfBuffer(buffer) || ext === 'rtf') {
    const text = extractRtfText(buffer);
    if (isMostlyReadableText(text)) {
      console.log(`[Doc] RTF: ${fileName}, ${text.length} симв.`);
      return text;
    }
    return failExtract(fileName, 'RTF прочитан, но полезного текста не найдено (пустой/только стили).');
  }

  // 2) DOCX/ODT — ZIP-контейнер (mammoth для docx; odt — XML из zip)
  if (isZipContainer(buffer) || ext === 'docx' || ext === 'odt') {
    if (ext === 'odt' || (isZipContainer(buffer) && ext !== 'docx')) {
      try {
        const JSZip = require('jszip');
        const zip = await JSZip.loadAsync(buffer);
        const content = zip.file('content.xml');
        if (content) {
          const xml = await content.async('string');
          const text = xml
            .replace(/<text:p[^>]*>/g, '\n')
            .replace(/<text:h[^>]*>/g, '\n')
            .replace(/<text:line-break\/>/g, '\n')
            .replace(/<text:tab\/>/g, '\t')
            .replace(/<[^>]+>/g, '')
            .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
            .replace(/[ \t]+\n/g, '\n')
            .replace(/\n{3,}/g, '\n\n')
            .trim();
          if (isMostlyReadableText(text)) {
            console.log(`[Doc] ODT: ${fileName}, ${text.length} симв.`);
            return text;
          }
        }
      } catch (err) {
        console.warn(`[Doc] ODT parse failed (${fileName}):`, err.message);
      }
    }
    try {
      const mammoth = require('mammoth');
      const result = await mammoth.extractRawText({ buffer });
      const text = String(result.value || '').trim();
      if (isMostlyReadableText(text)) {
        console.log(`[Doc] DOCX/mammoth: ${fileName}, ${text.length} симв.`);
        return text;
      }
      if (text.length === 0) {
        return failExtract(fileName, 'Документ открыт, но текстового содержимого нет (пустой шаблон/только стили).');
      }
    } catch (err) {
      console.warn(`[Doc] mammoth failed (${fileName}):`, err.message);
    }
  }

  // 3) Старый .doc (OLE)
  if (isOleCompound(buffer) || ext === 'doc') {
    const text = await extractOleDocText(buffer, fileName);
    if (text) return text;
    return failExtract(fileName, 'Не удалось извлечь текст из .doc (Word 97–2003). Пришлите DOCX или PDF.');
  }

  // 4) Никогда не отдаём бинарный dump в LLM
  return failExtract(fileName);
}

async function parseDocumentBuffer(buffer, family, fileName) {
  switch (family) {
    case 'pdf': {
      const pdfParse = require('pdf-parse');
      const data = await pdfParse(buffer);
      return data.text || '';
    }
    case 'doc': {
      return extractDocFamilyText(buffer, fileName);
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
      // JSZip умеет только ZIP (и docx/xlsx как zip). RAR/7z/tar — честный отказ.
      const ext = (fileName.split('.').pop() || '').toLowerCase();
      const isZipMagic = Buffer.isBuffer(buffer) && buffer.length >= 2
        && buffer[0] === 0x50 && buffer[1] === 0x4b; // "PK"
      const looksZip = isZipMagic || ext === 'zip' || ext === 'zipx';

      if (!looksZip) {
        console.log(`[Doc] Архив ${fileName}: формат «${ext || '?'}» — читаем только ZIP`);
        return `[Архив: ${fileName}] Формат «${ext || 'неизвестный'}» пока не распаковывается. `
          + 'Пришлите ZIP (или файлы из архива по отдельности: PDF, DOCX, XLSX, TXT).';
      }

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
          // Пропускаем служебные/скрытые (macOS __MACOSX, .DS_Store)
          if (/(^|\/)(__MACOSX|\.DS_Store)(\/|$)/i.test(entryName)) continue;
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
        console.error(`[Doc] ZIP parse error (${fileName}):`, err.message);
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

  console.log(`[Doc] Входящий документ: "${document_file_name}" | MIME: ${normalized.document_mime_type || '?'} | family: ${document_family} | канал: ${channel}`);

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

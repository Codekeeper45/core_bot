'use strict';

// Превращает markdown-таблицы в плоские строки (мессенджеры ломают |-разметку).
// Строку-разделитель | --- | --- | выкидываем; строку | a | b | → "a — b".
function flattenTables(text) {
  const lines = String(text).split('\n');
  const out = [];
  for (const line of lines) {
    const t = line.trim();
    // разделитель таблицы: только | - : и пробелы, и есть хотя бы один дефис
    if (/^\|?[\s|:-]*-[\s|:-]*\|?$/.test(t) && t.includes('-')) continue;
    // строка-таблица: начинается и/или заканчивается | и содержит разделители колонок
    if (/\|/.test(t) && /^\|.*\|?$/.test(t)) {
      const cells = t.replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim()).filter(Boolean);
      out.push(cells.join(' — '));
    } else {
      out.push(line);
    }
  }
  return out.join('\n');
}

function stripMarkdown(text) {
  return text
    // Bold/italic: **text**, *text*, __text__, _text_
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/\*(.+?)\*/g, '$1')
    .replace(/__(.+?)__/g, '$1')
    .replace(/_(.+?)_/g, '$1')
    // Strikethrough: ~~text~~
    .replace(/~~(.+?)~~/g, '$1')
    // Inline code: `text`
    .replace(/`(.+?)`/g, '$1')
    // Code blocks: ```text```
    .replace(/```[\s\S]*?```/g, (m) => m.replace(/```/g, '').trim())
    // Headers: # ## ###
    .replace(/^#{1,6}\s+/gm, '')
    // Links: [text](url) → text
    .replace(/\[(.+?)\]\(.+?\)/g, '$1')
    // Horizontal rules: --- or ***
    .replace(/^[-*]{3,}\s*$/gm, '')
    // Trailing spaces from removed markers
    .replace(/[ \t]+$/gm, '')
    .trim();
}

// Вырезает служебную разметку вызова инструментов, если модель напечатала её как ТЕКСТ:
// <｜｜DSML｜｜tool_calls>…invoke name=…parameter name=…, а также [Вызов: …]/[Tool …].
// Полноширинный пайп ｜ (U+FF5C) и обычный | оба учтены.
function stripToolMarkup(text) {
  let t = String(text);
  // Всё от первого DSML-маркера до конца — это сырой хвост вызова модели.
  t = t.replace(/<\s*[｜|]{1,3}\s*DSML[\s\S]*$/i, '');
  // Одиночные служебные теги вида <｜｜…｜｜>.
  t = t.replace(/<\s*[｜|]{2,}[\s\S]*?[｜|]{2,}\s*>/g, '');
  // Строки-описания вызова в прозе.
  t = t.replace(/^\s*(invoke|parameter)\s+name\s*=.*$/gim, '');
  // Пометки [Вызов: …] / [Tool …] (без \b — он не работает перед кириллицей в JS).
  t = t.replace(/\[\s*(вызов|tool)[^\]]*\]/gi, '');
  return t;
}

function sanitizeReply(text = '') {
  if (!text) return text;
  const had = String(text).trim().length > 0;
  let result = stripToolMarkup(text);
  // Если после удаления разметки не осталось содержимого — вернуть пусто (вызывающий не отправит).
  if (had && !result.trim()) return '';
  result = flattenTables(result);
  result = stripMarkdown(result);
  result = result.replace(/\b(\d{4})\d{8}(\d{4})\b/g, '$1****$2');
  result = result.replace(/\b(\d{4})\d{4}(\d{4})\b/g, (match, p1, p2) => {
    if (match.length === 12) return `${p1}****${p2}`;
    return match;
  });
  return result;
}

function sanitizeLog(text = '') {
  if (!text) return text;
  let result = text;
  result = result.replace(/(\+?\d{1,3})(\d{3})(\d{3})(\d{2})(\d{2})/g, '$1$2***$4$5');
  result = result.replace(/\b(\d{4})\d{8}(\d{4})\b/g, '$1********$2');
  result = result.replace(/\b(\d{4})\d{4}(\d{4})\b/g, '$1****$2');
  return result;
}

module.exports = { sanitizeReply, sanitizeLog, stripToolMarkup };

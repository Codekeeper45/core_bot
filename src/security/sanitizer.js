'use strict';

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

function sanitizeReply(text = '') {
  if (!text) return text;
  let result = stripMarkdown(text);
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

module.exports = { sanitizeReply, sanitizeLog };

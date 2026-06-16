'use strict';
// Чистые функции вьювера чатов — без БД и сети, чтобы покрывать тестами.

// Только цифры из строки (телефон/jid/id).
function digits(s) {
  return String(s == null ? '' : s).replace(/\D/g, '');
}

// Единый ключ карты сотрудников и поиска по чату.
// WhatsApp — по цифрам (jid вида 7707...@s.whatsapp.net → 7707...); прочие каналы — как есть.
function empKey(channel, contact) {
  const ch = String(channel || '');
  if (ch === 'whatsapp') return `${ch}:${digits(contact)}`;
  return `${ch}:${String(contact == null ? '' : contact)}`;
}

// Имя собеседника из карты сотрудников (Map ключ→имя) или null.
function resolveName(channel, chatId, empMap) {
  if (!empMap) return null;
  return empMap.get(empKey(channel, chatId)) || null;
}

// Короткое имя инструмента из tool_call.
function toolCallName(tc) {
  return (tc && tc.function && tc.function.name) || (tc && tc.name) || 'tool';
}

// Краткая заметка по результату инструмента (роль tool): ✓/✗ + сообщение, если есть.
function toolResultNote(content) {
  if (typeof content !== 'string' || !content) return 'результат инструмента';
  let obj;
  try { obj = JSON.parse(content); } catch (_) { return trim(content, 120); }
  if (obj && typeof obj === 'object') {
    const mark = obj.success === false ? '✗' : (obj.success === true ? '✓' : '•');
    const msg = obj.message || obj.note || obj.reason || '';
    return msg ? `${mark} ${trim(String(msg), 120)}` : `${mark} результат инструмента`;
  }
  return trim(content, 120);
}

function trim(s, n) {
  const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
}

// Привести историю OpenAI-стиля к читаемым строкам [{role, text, tools?}].
// Никогда не бросает: кривые/частичные формы просто пропускаются или сводятся к тексту.
function cleanMessages(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const m of raw) {
    if (!m || typeof m !== 'object') continue;
    const role = m.role;
    if (role === 'system') continue; // системные не показываем
    if (role === 'user') {
      out.push({ role: 'user', text: textOf(m.content) });
    } else if (role === 'assistant') {
      const item = { role: 'assistant', text: textOf(m.content) };
      if (Array.isArray(m.tool_calls) && m.tool_calls.length) {
        item.tools = m.tool_calls.map(toolCallName);
      }
      out.push(item);
    } else if (role === 'tool') {
      out.push({ role: 'tool', text: toolResultNote(m.content) });
    }
  }
  return out;
}

// content может быть строкой, null (assistant с tool_calls) или массивом частей (vision).
function textOf(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((p) => (p && typeof p === 'object' && typeof p.text === 'string' ? p.text : '')).join(' ').trim();
  }
  return '';
}

// Превью чата для списка: кол-во реплик и последняя непустая.
function previewOf(raw) {
  const cleaned = cleanMessages(raw);
  let last = null;
  for (let i = cleaned.length - 1; i >= 0; i--) {
    const c = cleaned[i];
    const t = c.text || (c.tools ? '🔧 ' + c.tools.join(', ') : '');
    if (t) { last = { role: c.role, text: trim(t, 90) }; break; }
  }
  return { count: cleaned.length, last };
}

module.exports = { digits, empKey, resolveName, cleanMessages, previewOf, toolResultNote, trim };

'use strict';
const config = require('../config');

// Rolling context summarization.
//
// The chat-history array interleaves assistant messages that carry `tool_calls`
// with their matching `role:"tool"` result messages. The OpenAI/OpenRouter API
// rejects a request if a tool result has no preceding assistant tool_call (or an
// assistant tool_call has no following result). So we may only split the array
// at a "clean turn boundary": an index whose message is a `user` message or a
// plain `assistant` message (no tool_calls). Splitting there guarantees both the
// summarized chunk and the kept chunk stay API-valid.

function totalChars(messages) {
  let n = 0;
  for (const m of messages || []) {
    if (typeof m.content === 'string') n += m.content.length;
    if (m.tool_calls) n += JSON.stringify(m.tool_calls).length;
  }
  return n;
}

// First index >= desiredCut that is a safe turn-start. Returns messages.length
// if none is safe (then summarize everything — rare).
function findCleanCut(messages, desiredCut) {
  let k = Math.max(0, desiredCut);
  while (k < messages.length) {
    const m = messages[k];
    if (m.role === 'user' || (m.role === 'assistant' && !m.tool_calls)) return k;
    k++;
  }
  return messages.length;
}

function renderTranscript(msgs) {
  return msgs.map((m) => {
    if (m.role === 'tool') {
      const c = typeof m.content === 'string' ? m.content.slice(0, 500) : '';
      return `[результат инструмента]: ${c}`;
    }
    if (m.role === 'assistant' && m.tool_calls) {
      return `Бот вызвал инструменты: ${m.tool_calls.map((t) => t.function && t.function.name).filter(Boolean).join(', ')}`;
    }
    const who = m.role === 'user' ? 'Клиент' : 'Бот';
    return `${who}: ${typeof m.content === 'string' ? m.content : ''}`;
  }).join('\n');
}

const SUMMARY_SYSTEM = `Ты ведёшь долгую память чат-бота: сжимаешь старую часть диалога с пользователем в СТРУКТУРИРОВАННУЮ сводку, по которой бот продолжит общение так, будто помнит весь разговор.

Верни сводку РОВНО в таком формате (заголовки сохраняй дословно; пустую секцию помечай «—»):

ФАКТЫ:
- Ключевые факты и цифры, НАЗВАННЫЕ ПОЛЬЗОВАТЕЛЕМ (с указанием, когда это было сказано). Только то, что озвучил сам пользователь.

КОНТЕКСТ:
- Кто пользователь, его цели и главная задача, предпочтения, тон общения, язык.

РЕШЕНИЯ И ДОГОВОРЁННОСТИ:
- Что бот или менеджер пообещали и когда; передавали ли менеджеру и с каким итогом; на каком этапе диалог остановился.

ХОД БЕСЕДЫ:
- Конфликты, жалобы, недовольство, сбои и проблемы; возражения пользователя и сняты ли они (или остались); открытые вопросы, на которые бот ещё не ответил.

СТАТУС И СЛЕДУЮЩИЙ ШАГ:
- На чём именно остановились; что сейчас В ПРОЦЕССЕ и не доведено до конца; какой ВОПРОС бот задал последним и ждёт ли на него ответ; что бот должен сделать ДАЛЬШЕ; чего ждём от пользователя. Формулируй так, чтобы по этой строке можно было продолжить с того же места, не начиная заново.

Правила:
- По-русски, тезисами. Длину выбирай сам по сути диалога: пиши ровно столько, чтобы ничего важного не потерять, без воды и повторов. Жёсткого лимита нет.
- В ФАКТЫ клади ИСХОДНЫЕ данные от пользователя дословно.
- Конфликты и проблемы фиксируй ВСЕГДА, даже если они уже сглажены — бот должен помнить, что инцидент был, и вести себя бережно.
- Если дана ПРЕДЫДУЩАЯ СВОДКА — объедини её с новым материалом в той же структуре, не теряя ранее зафиксированных фактов и инцидентов.`;

// { messages, summary, changed }. Never throws — on any failure returns the
// inputs unchanged so the user reply is never blocked.
async function summarizeIfNeeded({ messages, summary, openai, model }) {
  const limit = config.CONTEXT_SUMMARY_CHAR_LIMIT;
  const keepRecent = config.CONTEXT_KEEP_RECENT_MSGS;
  const msgs = Array.isArray(messages) ? messages : [];
  const cur = summary || '';

  if (msgs.length <= keepRecent || totalChars(msgs) <= limit) {
    return { messages: msgs, summary: cur, changed: false };
  }

  const cut = findCleanCut(msgs, msgs.length - keepRecent);
  if (cut <= 0) return { messages: msgs, summary: cur, changed: false };

  const toSummarize = msgs.slice(0, cut);
  const kept = msgs.slice(cut);
  const userContent =
    (cur ? `ПРЕДЫДУЩАЯ СВОДКА:\n${cur}\n\n` : '') +
    `НОВЫЙ ФРАГМЕНТ ДИАЛОГА:\n${renderTranscript(toSummarize)}`;

  try {
    const resp = await openai.chat.completions.create({
      model,
      messages: [
        { role: 'system', content: SUMMARY_SYSTEM },
        { role: 'user', content: userContent },
      ],
      tool_choice: 'none',
    });
    const newSummary = resp.choices && resp.choices[0]
      && resp.choices[0].message && resp.choices[0].message.content
      && resp.choices[0].message.content.trim();
    if (!newSummary) return { messages: msgs, summary: cur, changed: false };
    return { messages: kept, summary: newSummary, changed: true };
  } catch (err) {
    console.error('[ContextManager] summarize error:', err.message);
    return { messages: msgs, summary: cur, changed: false };
  }
}

module.exports = { summarizeIfNeeded, totalChars, findCleanCut, SUMMARY_SYSTEM };

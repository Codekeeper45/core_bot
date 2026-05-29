'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const config = require('../src/config');
const { summarizeIfNeeded, totalChars, findCleanCut, SUMMARY_SYSTEM } = require('../src/agent/contextManager');

// Shrink thresholds for deterministic tests (config is a shared object).
config.CONTEXT_SUMMARY_CHAR_LIMIT = 200;
config.CONTEXT_KEEP_RECENT_MSGS = 3;

const okClient = (calls) => ({
  chat: { completions: { create: async (args) => { calls.push(args); return { choices: [{ message: { content: 'СВОДКА ДИАЛОГА' } }] }; } } },
});
const throwingClient = { chat: { completions: { create: async () => { throw new Error('LLM down'); } } } };

function bigMsgs(n) {
  return Array.from({ length: n }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: 'x'.repeat(60) + ' #' + i }));
}

test('summary prompt is structured and keeps the right rules', () => {
  for (const h of ['ФАКТЫ:', 'КОНТЕКСТ:', 'РЕШЕНИЯ И ДОГОВОРЁННОСТИ:', 'ХОД БЕСЕДЫ:', 'СТАТУС И СЛЕДУЮЩИЙ ШАГ:']) {
    assert.ok(SUMMARY_SYSTEM.includes(h), `missing section header: ${h}`);
  }
  // User-stated facts captured verbatim, conflicts always remembered.
  assert.ok(SUMMARY_SYSTEM.includes('ИСХОДНЫЕ данные от пользователя'), 'must capture user-stated facts');
  assert.ok(SUMMARY_SYSTEM.includes('Конфликты и проблемы фиксируй ВСЕГДА'), 'must always record conflicts');
});

test('totalChars counts content and tool_calls', () => {
  const n = totalChars([{ role: 'user', content: 'abcde' }, { role: 'assistant', content: '', tool_calls: [{ x: 1 }] }]);
  assert.ok(n >= 5 + JSON.stringify([{ x: 1 }]).length);
});

test('findCleanCut skips orphan tool result to next clean turn-start', () => {
  const msgs = [
    { role: 'user', content: 'a' },
    { role: 'assistant', tool_calls: [{ id: 't1', function: { name: 'save' } }] },
    { role: 'tool', tool_call_id: 't1', content: 'res' },
    { role: 'assistant', content: 'ok' },
    { role: 'user', content: 'b' },
  ];
  // desiredCut=2 points at the tool result (illegal split) → must advance to 3 (clean assistant).
  assert.strictEqual(findCleanCut(msgs, 2), 3);
  assert.strictEqual(findCleanCut(msgs, 1), 3); // index 1 = assistant w/ tool_calls → illegal too
});

test('under limit → unchanged, no LLM call', async () => {
  const calls = [];
  const messages = [{ role: 'user', content: 'короткое' }];
  const r = await summarizeIfNeeded({ messages, summary: '', openai: okClient(calls), model: 'm' });
  assert.strictEqual(r.changed, false);
  assert.strictEqual(calls.length, 0);
  assert.strictEqual(r.messages, messages);
});

test('over limit → summarized, kept window valid, LLM called once', async () => {
  const calls = [];
  const messages = bigMsgs(12); // 12 * ~64 chars = ~768 > 200, length 12 > keepRecent 3
  const r = await summarizeIfNeeded({ messages, summary: '', openai: okClient(calls), model: 'm' });
  assert.strictEqual(r.changed, true);
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(r.summary, 'СВОДКА ДИАЛОГА');
  assert.ok(r.messages.length < messages.length, 'history shrunk');
  // kept chunk must start at a clean turn-start (user or assistant w/o tool_calls)
  const first = r.messages[0];
  assert.ok(first.role === 'user' || (first.role === 'assistant' && !first.tool_calls));
});

test('previous summary is merged into the LLM input', async () => {
  const calls = [];
  await summarizeIfNeeded({ messages: bigMsgs(12), summary: 'СТАРАЯ СВОДКА', openai: okClient(calls), model: 'm' });
  const userMsg = calls[0].messages.find((m) => m.role === 'user').content;
  assert.ok(userMsg.includes('ПРЕДЫДУЩАЯ СВОДКА'));
  assert.ok(userMsg.includes('СТАРАЯ СВОДКА'));
});

test('summarizer failure is non-fatal → inputs returned unchanged', async () => {
  const messages = bigMsgs(12);
  const r = await summarizeIfNeeded({ messages, summary: 'keep', openai: throwingClient, model: 'm' });
  assert.strictEqual(r.changed, false);
  assert.strictEqual(r.messages, messages);
  assert.strictEqual(r.summary, 'keep');
});

test('tool round straddling the cut stays API-valid (no orphan tool result kept)', async () => {
  const calls = [];
  // Build: 8 plain msgs, then a tool round near the boundary, then 3 recent.
  const messages = [
    ...bigMsgs(8),
    { role: 'assistant', tool_calls: [{ id: 'tA', function: { name: 'notify_manager' } }] },
    { role: 'tool', tool_call_id: 'tA', content: 'x'.repeat(80) },
    { role: 'assistant', content: 'recent-1' },
    { role: 'user', content: 'recent-2' },
    { role: 'assistant', content: 'recent-3' },
  ];
  const r = await summarizeIfNeeded({ messages, summary: '', openai: okClient(calls), model: 'm' });
  assert.strictEqual(r.changed, true);
  // No kept message may be an orphan tool result, and none may be an assistant
  // with tool_calls whose result was summarized away.
  assert.ok(r.messages.every((m) => m.role !== 'tool' || r.messages.some((p, i) =>
    p.role === 'assistant' && p.tool_calls && r.messages.indexOf(m) > i)),
    'no orphan tool result in kept chunk');
  const first = r.messages[0];
  assert.ok(first.role === 'user' || (first.role === 'assistant' && !first.tool_calls));
});

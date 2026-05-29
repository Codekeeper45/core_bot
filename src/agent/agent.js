'use strict';
const OpenAI = require('openai');
const config = require('../config');
const { getSystemPrompt } = require('./systemPrompt');
const { loadChatHistory, saveChatHistory } = require('./memory');
const { tools, executeToolCall } = require('../tools');
const { runNotifyManager } = require('../tools/notifyManager');
const { withRetry } = require('../utils/retry');

const FALLBACK_AI = 'Произошла ошибка при обработке сообщения. Пожалуйста, повторите запрос чуть позже.';
const LLM_MAX_RETRIES = 3; // 3 retries = 4 total attempts (first retry after 20s for 429)

// Observability: agent run outcomes. Every non-success outcome = a degraded
// client experience (Insight #7: каждый баг = потерянный лид). Surfaced via /health.
const agentMetrics = {
  total: 0,
  success: 0,
  llm_error: 0,          // LLM API failed after retries → escalated to manager
  loop_exhausted: 0,     // 20 iterations without a text reply
  fallback_recovered: 0, // loop exhausted but final no-tool call produced a reply
  empty_reply: 0,        // even fallback produced nothing → FALLBACK_AI
  unexpected_error: 0,   // uncaught exception in the agent loop
  fallback_model_used: 0, // primary model failed → backup model served the request
};
function getAgentMetrics() { return { ...agentMetrics }; }

const _toolCallHooks = new Set();

function onToolCall(fn) {
  _toolCallHooks.add(fn);
  return () => _toolCallHooks.delete(fn);
}

let _deepseek, _openrouter;
function getDeepSeekClient() {
  if (!_deepseek) _deepseek = new OpenAI({ baseURL: config.DEEPSEEK_BASE_URL, apiKey: config.DEEPSEEK_API_KEY });
  return _deepseek;
}
function getOpenRouterClient() {
  if (!_openrouter) _openrouter = new OpenAI({ baseURL: 'https://openrouter.ai/api/v1', apiKey: config.OPENROUTER_API_KEY });
  return _openrouter;
}

// Ordered providers to try for TEXT generation (chat + tool calling):
//   1) DeepSeek direct (if DEEPSEEK_API_KEY set) — primary,
//   2) OpenRouter primary model — fallback,
//   3) OpenRouter backup model — last resort.
// STT/Vision are NOT here: DeepSeek has no audio/vision, they stay on OpenRouter
// in services/openrouterMedia.js.
function getTextLLMChain() {
  const chain = [];
  if (config.DEEPSEEK_API_KEY) {
    chain.push({ client: getDeepSeekClient(), model: config.DEEPSEEK_MODEL, label: `deepseek:${config.DEEPSEEK_MODEL}` });
  }
  if (config.OPENROUTER_API_KEY) {
    chain.push({ client: getOpenRouterClient(), model: config.OPENROUTER_MODEL, label: `openrouter:${config.OPENROUTER_MODEL}` });
    if (config.OPENROUTER_FALLBACK_MODEL && config.OPENROUTER_FALLBACK_MODEL !== config.OPENROUTER_MODEL) {
      chain.push({ client: getOpenRouterClient(), model: config.OPENROUTER_FALLBACK_MODEL, label: `openrouter:${config.OPENROUTER_FALLBACK_MODEL}` });
    }
  }
  return chain;
}

// Primary text {client, model} — for callers needing a single client (e.g. контекст-саммари).
function getPrimaryTextLLM() {
  const chain = getTextLLMChain();
  if (chain.length === 0) throw new Error('No LLM provider configured (set DEEPSEEK_API_KEY or OPENROUTER_API_KEY)');
  return chain[0];
}
// Back-compat alias: returns the primary text client.
function getOpenAI() { return getPrimaryTextLLM().client; }

// Run a chat completion through the provider chain: each provider gets `retryOpts`
// retries; if it still fails (outage / no response), fall through to the next.
// `makeParams(model)` builds the request body for a given model.
// An optional `client` pins every attempt to that one client (used by tests and
// any caller that wants a fixed provider) while STILL iterating the configured
// models for fallback — primary model, then OPENROUTER_FALLBACK_MODEL.
async function llmCreateWithFallback(makeParams, retryOpts, client) {
  let chain;
  if (client) {
    chain = [];
    if (config.OPENROUTER_MODEL) chain.push({ client, model: config.OPENROUTER_MODEL, label: `pinned:${config.OPENROUTER_MODEL}` });
    if (config.OPENROUTER_FALLBACK_MODEL && config.OPENROUTER_FALLBACK_MODEL !== config.OPENROUTER_MODEL) {
      chain.push({ client, model: config.OPENROUTER_FALLBACK_MODEL, label: `pinned:${config.OPENROUTER_FALLBACK_MODEL}` });
    }
    if (chain.length === 0) chain.push({ client, model: getPrimaryTextLLM().model, label: 'pinned' });
  } else {
    chain = getTextLLMChain();
  }
  if (chain.length === 0) throw new Error('No LLM provider configured (set DEEPSEEK_API_KEY or OPENROUTER_API_KEY)');
  let lastErr;
  for (let i = 0; i < chain.length; i++) {
    const { client: oa, model, label } = chain[i];
    try {
      return await withRetry(() => oa.chat.completions.create(makeParams(model)), retryOpts);
    } catch (err) {
      lastErr = err;
      const more = i < chain.length - 1;
      console.error(`[Agent] LLM ${label} failed after retries (${err.message})${more ? '; switching to next provider' : '; no more providers'}`);
      if (more) agentMetrics.fallback_model_used++;
    }
  }
  throw lastErr;
}

// Assemble the message list sent to the LLM: main system prompt, then the
// rolling long-term summary (if any) as a second system message, then history.
function buildLLMMessages(systemPrompt, convoSummary, messages) {
  const head = [{ role: 'system', content: systemPrompt }];
  if (convoSummary) {
    head.push({
      role: 'system',
      content: `=== СВОДКА ПРЕДЫДУЩЕГО ДИАЛОГА (долгая память, старая часть переписки сжата) ===\n${convoSummary}`,
    });
  }
  return [...head, ...messages];
}

async function runAgent({ combinedMessage, channel, chatId, phone, clientName }) {
  const context = { channel, chatId, phone, clientName };

  let messages = [];
  let convoSummary = '';
  try {
    const hist = await loadChatHistory(channel, chatId);
    messages = hist.messages || [];
    convoSummary = hist.summary || '';
  } catch { messages = []; convoSummary = ''; }

  messages.push({ role: 'user', content: combinedMessage });

  const systemPrompt = getSystemPrompt(clientName, phone, channel);
  let replyText = '';
  agentMetrics.total++;

  try {
    for (let i = 0; i < config.AI_MAX_ITERATIONS; i++) {
      let response;
      try {
        response = await llmCreateWithFallback(
          (model) => ({
            model,
            messages: buildLLMMessages(systemPrompt, convoSummary, messages),
            tools,
            tool_choice: 'auto',
          }),
          { maxRetries: LLM_MAX_RETRIES, baseDelay: 2000 }
        );
      } catch (llmErr) {
        agentMetrics.llm_error++;
        console.error('[Agent] LLM error after retries:', llmErr.message);
        // After all retries failed — escalate to manager if possible
        if (context?.chatId && context?.channel) {
          try {
            await runNotifyManager({
              channel: context.channel,
              chat_id: context.chatId,
              client_name: context.clientName || '',
              phone: context.phone || '',
              event_type: 'escalation',
              summary: `⚠️ Сбой AI: не удалось обработать сообщение клиента. Требуется ручной ответ.`,
            });
          } catch (notifyErr) {
            console.error('[Agent] Notify manager error:', notifyErr.message);
          }
        }
        return 'Наши системы немного загружены. Наш специалист свяжется с вами в ближайшее время. Спасибо за терпение!';
      }

      const choice = response.choices[0];
      if (!choice) break;

      if (choice.finish_reason === 'tool_calls' && choice.message.tool_calls?.length) {
        messages.push(choice.message);

        for (const toolCall of choice.message.tool_calls) {
          let toolResult;
          const toolName = toolCall.function.name;
          let toolArgs;
          try {
            toolArgs = JSON.parse(toolCall.function.arguments || '{}');
            toolResult = await executeToolCall(toolName, toolArgs, context);
          } catch (err) {
            toolResult = { success: false, message: 'Tool execution error: ' + err.message };
          }
          for (const hook of _toolCallHooks) {
            try { hook(toolName, toolArgs || {}, toolResult); } catch (_) {}
          }
          messages.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            content: JSON.stringify(toolResult),
          });
        }
      } else {
        replyText = choice.message?.content || '';
        messages.push({ role: 'assistant', content: replyText });
        break;
      }
    }
  } catch (err) {
    agentMetrics.unexpected_error++;
    console.error('[Agent] Unexpected error:', err.message);
    return FALLBACK_AI;
  }

  // If the loop exhausted iterations without a text reply, make one final direct call
  if (!replyText) {
    agentMetrics.loop_exhausted++;
    console.warn('[Agent] No reply after loop — making final fallback call');
    try {
      const fallbackResp = await llmCreateWithFallback(
        (model) => ({
          model,
          messages: buildLLMMessages(systemPrompt, convoSummary, messages),
          tool_choice: 'none',
        }),
        { maxRetries: 2, baseDelay: 1000 }
      );
      replyText = fallbackResp.choices[0]?.message?.content || '';
    } catch (_) {}
    if (!replyText) {
      agentMetrics.empty_reply++;
      return FALLBACK_AI;
    }
    agentMetrics.fallback_recovered++;
  }

  agentMetrics.success++;

  // Roll old context into the running summary once history grows past the
  // char limit (keeps the bot autonomous over long conversations). Only fires
  // when oversized — adds one LLM call infrequently; failures are non-fatal.
  try {
    const { summarizeIfNeeded } = require('./contextManager');
    const res = await summarizeIfNeeded({
      messages,
      summary: convoSummary,
      openai: getPrimaryTextLLM().client,
      model: getPrimaryTextLLM().model,
    });
    messages = res.messages;
    convoSummary = res.summary;
    if (res.changed) console.log(`[Agent] Context summarized for ${channel}:${chatId} — kept ${messages.length} msgs`);
  } catch (err) {
    console.error('[Agent] Summarize step error:', err.message);
  }

  try {
    await saveChatHistory(channel, chatId, messages, convoSummary);
  } catch (err) {
    console.error('[Agent] Save history error:', err.message);
  }

  return replyText;
}

module.exports = { runAgent, onToolCall, getAgentMetrics, llmCreateWithFallback };
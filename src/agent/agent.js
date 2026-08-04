'use strict';
const OpenAI = require('openai');
const config = require('../config');
const { getSystemPrompt } = require('./systemPrompt');
const { loadChatHistory, saveChatHistory } = require('./memory');
const { executeToolCall, toolsForRole } = require('../tools');
const notifier = require('../services/notifier');
const { logToolRun } = require('../services/mysql');
const { withRetry } = require('../utils/retry');
const { formatToolEcho } = require('../utils/toolEcho');
const { sanitizeReply } = require('../security/sanitizer');

// Честные сообщения об ошибках: бот обслуживает только своих (босс/сотрудники),
// поэтому говорим прямо, что и где сломалось и что делать, а не «системы загружены».
// Честные и понятные тексты для человека (без жаргона .env/OPENROUTER_MODEL — техдетали
// идут в логи сервера). Босс=оператор, поэтому действие подсказываем простыми словами.
const FALLBACK_NO_CREDITS = '⚠️ Не могу ответить: закончились средства на балансе ИИ. Нужно пополнить баланс — и я снова в строю.';
const FALLBACK_MODEL_REJECTED = '⚠️ Не могу ответить: выбранная модель ИИ не подходит (не поддерживает инструменты). Нужно сменить модель ИИ в настройках.';
const FALLBACK_RATE_LIMIT = '⚠️ ИИ перегружен запросами. Подождите минуту и повторите.';
const FALLBACK_MODEL_EMPTY = '⚠️ ИИ не дал ответ. Попробуйте ещё раз; если повторяется — нужно сменить модель ИИ в настройках.';
const FALLBACK_NETWORK = '⚠️ Нет связи с ИИ (сеть или таймаут). Повторите чуть позже.';
const FALLBACK_NO_PROVIDER = '⚠️ ИИ не настроен (не задан ключ). Нужно указать ключ ИИ в настройках сервера.';
const FALLBACK_LLM_GENERIC = '⚠️ ИИ временно не отвечает. Повторите чуть позже; если не проходит — нужно проверить настройки и баланс ИИ (детали в логах сервера).';
const FALLBACK_INTERNAL = '⚠️ Не получилось обработать сообщение — внутренняя ошибка. Повторите ещё раз; детали в логах сервера.';
// Совместимость со старыми ссылками + детектор «это аварийный ответ» (для планировщика).
const FALLBACK_AI = FALLBACK_INTERNAL;
const FALLBACK_BUSY = FALLBACK_LLM_GENERIC;
const FALLBACK_MESSAGES = new Set([
  FALLBACK_NO_CREDITS, FALLBACK_MODEL_REJECTED, FALLBACK_RATE_LIMIT, FALLBACK_MODEL_EMPTY,
  FALLBACK_NETWORK, FALLBACK_NO_PROVIDER, FALLBACK_LLM_GENERIC, FALLBACK_INTERNAL,
]);

// Превратить ошибку провайдера в честное сообщение по её сути.
function classifyLlmError(message) {
  const m = String(message || '');
  if (/no llm provider configured/i.test(m)) return FALLBACK_NO_PROVIDER;
  if (/\b402\b|insufficient|credit|afford|balance|more credits/i.test(m)) return FALLBACK_NO_CREDITS;
  if (/\b429\b|rate.?limit|too many requests/i.test(m)) return FALLBACK_RATE_LIMIT;
  if (/некорректный ответ|no choices|без choices|empty (response|reply)/i.test(m)) return FALLBACK_MODEL_EMPTY;
  if (/\b400\b|provider returned error|unsupported|invalid request|not support|no endpoints/i.test(m)) return FALLBACK_MODEL_REJECTED;
  if (/timeout|etimedout|econnreset|enotfound|econnrefused|network|socket|fetch failed|ehostunreach/i.test(m)) return FALLBACK_NETWORK;
  return FALLBACK_LLM_GENERIC;
}

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

let _deepseek, _openrouter, _anymodel;
function getDeepSeekClient() {
  if (!_deepseek) _deepseek = new OpenAI({ baseURL: config.DEEPSEEK_BASE_URL, apiKey: config.DEEPSEEK_API_KEY });
  return _deepseek;
}
function getOpenRouterClient() {
  if (!_openrouter) _openrouter = new OpenAI({ baseURL: 'https://openrouter.ai/api/v1', apiKey: config.OPENROUTER_API_KEY });
  return _openrouter;
}
function getAnymodelClient() {
  if (!_anymodel) _anymodel = new OpenAI({ baseURL: config.ANYMODEL_BASE_URL, apiKey: config.ANYMODEL_API_KEY });
  return _anymodel;
}

// Умная цепочка провайдеров для ТЕКСТОВОГО агента (chat + tool calling):
//   1) DeepSeek direct (если DEEPSEEK_API_KEY) — primary,
//   2) OpenRouter primary model (DeepSeek V4 Flash) — fallback #1,
//   3) AnyModel (anymodel.org, am/glm-5.2) — fallback #2 (если задан ключ),
//   4) openrouter/free — глобальный бесплатный последний рубеж.
// STT/Vision НЕ здесь: DeepSeek/прямые провайдеры не умеют аудио/картинки — они
// живут в services/openrouterMedia.js (тоже с глобальным openrouter/free-фолбэком).
function getTextLLMChain() {
  const chain = [];
  if (config.DEEPSEEK_API_KEY) {
    chain.push({ client: getDeepSeekClient(), model: config.DEEPSEEK_MODEL, label: `deepseek:${config.DEEPSEEK_MODEL}` });
  }
  if (config.OPENROUTER_API_KEY) {
    chain.push({ client: getOpenRouterClient(), model: config.OPENROUTER_MODEL, label: `openrouter:${config.OPENROUTER_MODEL}` });
  }
  if (config.ANYMODEL_API_KEY && config.ANYMODEL_MODEL) {
    chain.push({ client: getAnymodelClient(), model: config.ANYMODEL_MODEL, label: `anymodel:${config.ANYMODEL_MODEL}` });
  }
  if (config.OPENROUTER_API_KEY && config.OPENROUTER_FALLBACK_MODEL && config.OPENROUTER_FALLBACK_MODEL !== config.OPENROUTER_MODEL) {
    chain.push({ client: getOpenRouterClient(), model: config.OPENROUTER_FALLBACK_MODEL, label: `openrouter:${config.OPENROUTER_FALLBACK_MODEL}` });
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
      const resp = await withRetry(() => oa.chat.completions.create(makeParams(model)), retryOpts);
      // Некоторые провайдеры (особенно бесплатные модели OpenRouter) на ошибку/лимит
      // отдают HTTP 200 с телом без choices (часто { error: {...} }). SDK это не бросает,
      // и дальше `resp.choices[0]` падал бы в unexpected_error. Считаем такой ответ сбоем
      // провайдера → ретрай/переход к следующему, как при обычной ошибке API.
      if (!resp || !Array.isArray(resp.choices) || resp.choices.length === 0) {
        const reason = resp && resp.error && resp.error.message ? resp.error.message : 'ответ без choices';
        throw new Error(`провайдер вернул некорректный ответ (${reason})`);
      }
      return resp;
    } catch (err) {
      lastErr = err;
      const more = i < chain.length - 1;
      console.error(`[Agent] LLM ${label} failed after retries (${err.message})${more ? '; switching to next provider' : '; no more providers'}`);
      if (more) agentMetrics.fallback_model_used++;
    }
  }
  throw lastErr;
}

// Хвост истории должен быть API-валидным: assistant с tool_calls обязан иметь
// ВСЕ свои tool-результаты следом, иначе следующий запрос получит 400 и чат
// «залипнет» до /new. Неполный последний блок срезаем целиком.
function dropDanglingToolTail(messages) {
  const msgs = Array.isArray(messages) ? [...messages] : [];
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m.role === 'tool') continue;
    if (m.role === 'assistant' && Array.isArray(m.tool_calls)) {
      const got = new Set(msgs.slice(i + 1).filter((x) => x.role === 'tool').map((x) => x.tool_call_id));
      return m.tool_calls.every((tc) => got.has(tc.id)) ? msgs : msgs.slice(0, i);
    }
    return msgs;
  }
  return msgs;
}

// Сохранить историю на аварийном пути выхода из агентного цикла. Инструменты
// предыдущих итераций могли УЖЕ выполниться (БД изменена, сообщения сотрудникам
// отправлены) — потеря этого хода означает дубли действий в следующем ходе.
// Дописываем assistant с фактически отправленным fallback-текстом, чтобы модель
// видела, чем закончился ход.
async function persistErrorHistory(channel, chatId, messages, convoSummary, sentText, historyVersion = null) {
  try {
    const msgs = dropDanglingToolTail(messages);
    msgs.push({ role: 'assistant', content: sentText });
    await saveChatHistory(channel, chatId, msgs, convoSummary, historyVersion);
  } catch (err) {
    console.error('[Agent] Save history (error path):', err.message);
  }
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

// Кап вызовов инструмента за один прогон. Мутирует counts. Возвращает {capped, result?}.
// Сверх лимита НЕ зовём инструмент реально, а просим модель остановиться (стоп зацикливанию).
function capToolCall(name, counts, limits = {}) {
  counts[name] = (counts[name] || 0) + 1;
  const lim = limits[name];
  if (lim && counts[name] > lim) {
    return {
      capped: true,
      result: { success: false, note: `Лимит вызовов «${name}» за этот запрос исчерпан (${lim}). Хватит — ответь по тому, что уже нашёл, или честно скажи, что точных данных нет.` },
    };
  }
  return { capped: false };
}

async function runAgent({
  combinedMessage, channel, chatId, phone, clientName, role, emit, media,
  maxIterations, messageOrigin, sourceMessageId,
}) {
  const runId = require('crypto').randomUUID();
  const context = {
    channel, chatId, phone, clientName, role: role || 'employee',
    messageOrigin: messageOrigin === 'scheduled' ? 'scheduled' : 'interactive',
    sourceMessageId: sourceMessageId || null,
    runId,
    incomingMedia: Array.isArray(media) ? media : [], // вложения текущего сообщения — для forward_message
  };
  // Тулы по роли: сотруднику не отдаём схемы boss-only (экономия токенов + меньше путаницы).
  const activeTools = toolsForRole(context.role);
  // Лимит итераций: scheduled-прогоны (deliverInstruction) короче — отдельный меньший потолок.
  const maxIters = maxIterations || config.AI_MAX_ITERATIONS;
  // emit(text) — отправка промежуточного сообщения в чат (авто-эхо тулов).
  const echo = (config.ECHO_TOOL_CALLS && typeof emit === 'function') ? emit : null;

  let messages = [];
  let convoSummary = '';
  let historyVersion = 0;
  try {
    const hist = await loadChatHistory(channel, chatId);
    messages = hist.messages || [];
    convoSummary = hist.summary || '';
    historyVersion = Number(hist.version) || 0;
  } catch { messages = []; convoSummary = ''; }

  messages.push({ role: 'user', content: combinedMessage });

  const systemPrompt = await getSystemPrompt(clientName, phone, channel, chatId);
  let replyText = '';
  const toolCounts = {}; // счётчик вызовов по имени за этот прогон (для капа web_search)
  agentMetrics.total++;

  try {
    for (let i = 0; i < maxIters; i++) {
      let response;
      try {
        response = await llmCreateWithFallback(
          (model) => ({
            model,
            messages: buildLLMMessages(systemPrompt, convoSummary, messages),
            tools: activeTools,
            tool_choice: 'auto',
            max_tokens: config.LLM_MAX_TOKENS,
          }),
          { maxRetries: LLM_MAX_RETRIES, baseDelay: 2000 }
        );
      } catch (llmErr) {
        agentMetrics.llm_error++;
        console.error('[Agent] LLM error after retries:', llmErr.message);
        const honest = classifyLlmError(llmErr.message);
        // After all retries failed — alert a human operator if MANAGER_* configured.
        try {
          await notifier.alertManager(
            `⚠️ Сбой AI (${context?.channel || '?'}:${context?.chatId || '?'}): ${llmErr.message}`
          );
        } catch (notifyErr) {
          console.error('[Agent] alertManager error:', notifyErr.message);
        }
        require('../services/developerFeedback').reportDeveloperError(llmErr.message, {
          channel: context.channel, chatId: context.chatId, actorName: context.clientName, includeHistory: true,
        }).catch(() => {});
        await persistErrorHistory(channel, chatId, messages, convoSummary, honest, historyVersion);
        return honest;
      }

      const choice = response.choices[0];
      if (!choice) break;

      if (choice.finish_reason === 'tool_calls' && choice.message.tool_calls?.length) {
        messages.push(choice.message);

        // Авто-эхо: одним сообщением показываем в чате, какие тулы бот сейчас зовёт.
        if (echo) {
          const lines = choice.message.tool_calls.map((tc) => {
            let a = {};
            try { a = JSON.parse(tc.function.arguments || '{}'); } catch (_) { /* частичный JSON — покажем без аргументов */ }
            return formatToolEcho(tc.function.name, a);
          }).filter(Boolean);
          if (lines.length) {
            try { await echo(lines.join('\n')); } catch (_) { /* эхо некритично */ }
          }
        }

        for (const toolCall of choice.message.tool_calls) {
          let toolResult;
          const toolName = toolCall.function.name;
          let toolArgs = {};
          try { toolArgs = JSON.parse(toolCall.function.arguments || '{}'); } catch (_) { /* частичный JSON */ }
          const cap = capToolCall(toolName, toolCounts, { web_search: config.WEB_SEARCH_MAX_PER_RUN });
          if (cap.capped) {
            toolResult = cap.result; // лимит исчерпан — не зовём реально, просим остановиться
          } else {
            try {
              toolResult = await executeToolCall(toolName, toolArgs, context);
            } catch (err) {
              toolResult = { success: false, message: 'Tool execution error: ' + err.message };
              require('../services/developerFeedback').reportDeveloperError(`Инструмент ${toolName}: ${err.message}`, {
                channel: context.channel, chatId: context.chatId, actorName: context.clientName, includeHistory: true,
              }).catch(() => {});
            }
          }
          if (toolResult && toolResult.success === false && toolResult.error === 'db') {
            require('../services/developerFeedback').reportDeveloperError(`Сбой БД в инструменте ${toolName}`, {
              channel: context.channel, chatId: context.chatId, actorName: context.clientName, includeHistory: true,
            }).catch(() => {});
          }
          for (const hook of _toolCallHooks) {
            try { hook(toolName, toolArgs || {}, toolResult); } catch (_) {}
          }
          try {
            if (typeof logToolRun === 'function') {
              await logToolRun({
                runId,
                toolCallId: toolCall.id,
                sourceMessageId: context.sourceMessageId,
                channel: context.channel,
                chatId: context.chatId,
                actorName: context.clientName,
                actorRole: context.role,
                tool: toolName,
                action: toolArgs && toolArgs.action,
                args: toolArgs,
                result: toolResult,
                success: !(toolResult && toolResult.success === false),
              });
            }
          } catch (err) {
            console.error('[Agent] Tool run audit:', err.message);
          }
          // Журнал действий бота (долгая память): что сделал, кто инициатор, итог.
          try {
            require('../services/mysql').logBotEvent({
              channel: context.channel, chatId: context.chatId,
              actorName: context.clientName, actorRole: context.role,
              tool: toolName, action: toolArgs && toolArgs.action,
              success: !(toolResult && toolResult.success === false),
              summary: (toolResult && (toolResult.note || toolResult.message)) || '',
            });
          } catch (_) {}
          messages.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            content: JSON.stringify(toolResult),
          });
        }
      } else {
        replyText = choice.message?.content || '';
        // Пустой ответ модели не пишем: fallback-вызов ниже добавит фактический.
        if (replyText) messages.push({ role: 'assistant', content: replyText });
        break;
      }
    }
  } catch (err) {
    agentMetrics.unexpected_error++;
    console.error('[Agent] Unexpected error:', err.message);
    require('../services/developerFeedback').reportDeveloperError(err.message, {
      channel: context.channel, chatId: context.chatId, actorName: context.clientName, includeHistory: true,
    }).catch(() => {});
    await persistErrorHistory(channel, chatId, messages, convoSummary, FALLBACK_AI, historyVersion);
    return FALLBACK_AI;
  }

  // If the loop exhausted iterations without a text reply, make one final direct call
  if (!replyText) {
    agentMetrics.loop_exhausted++;
    console.warn('[Agent] No reply after loop — making final fallback call');
    let _emptyReplyErr = null;
    try {
      const fallbackResp = await llmCreateWithFallback(
        (model) => ({
          model,
          messages: buildLLMMessages(systemPrompt, convoSummary, messages),
          tool_choice: 'none',
          max_tokens: config.LLM_MAX_TOKENS,
        }),
        { maxRetries: 2, baseDelay: 1000 }
      );
      replyText = fallbackResp?.choices?.[0]?.message?.content || '';
    } catch (fbErr) { replyText = ''; _emptyReplyErr = fbErr; }
    if (!replyText) {
      agentMetrics.empty_reply++;
      // Честно: если финальный вызов упал (402/400/сеть) — назвать причину; если просто
      // вернул пусто — значит модель не дала текст (не подходит).
      const honest = _emptyReplyErr ? classifyLlmError(_emptyReplyErr.message) : FALLBACK_MODEL_EMPTY;
      await persistErrorHistory(channel, chatId, messages, convoSummary, honest, historyVersion);
      return honest;
    }
    agentMetrics.fallback_recovered++;
    // Fallback-ответ должен попасть в историю: цикл его не push'ил (вышли без
    // текстового assistant), а сохранение ниже пишет messages как есть.
    messages.push({ role: 'assistant', content: replyText });
  }

  // История должна содержать тот же текст, который увидит человек, а не сырой
  // ответ модели до удаления служебной разметки и чувствительных номеров.
  const deliveredReply = sanitizeReply(replyText);
  if (deliveredReply !== replyText) {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'assistant' && messages[i].content === replyText) {
        messages[i] = { ...messages[i], content: deliveredReply };
        break;
      }
    }
    replyText = deliveredReply;
  }

  agentMetrics.success++;

  // Roll old context into the running summary once history grows past the
  // char limit (keeps the bot autonomous over long conversations). Only fires
  // when oversized — adds one LLM call infrequently; failures are non-fatal.
  try {
    const { summarizeIfNeeded } = require('./contextManager');
    // Сворачивание контекста — тоже LLM-вызов: гоняем через умную цепочку
    // (DeepSeek → OpenRouter → AnyModel → openrouter/free), чтобы сбой primary
    // не ронял память бота.
    const smartClient = {
      chat: {
        completions: {
          create: (params) => llmCreateWithFallback(
            (model) => ({ ...params, model }),
            { maxRetries: 1, baseDelay: 500 }
          ),
        },
      },
    };
    const res = await summarizeIfNeeded({
      messages,
      summary: convoSummary,
      openai: smartClient,
      model: getPrimaryTextLLM().model,
    });
    messages = res.messages;
    convoSummary = res.summary;
    if (res.changed) console.log(`[Agent] Context summarized for ${channel}:${chatId} — kept ${messages.length} msgs`);
  } catch (err) {
    console.error('[Agent] Summarize step error:', err.message);
  }

  try {
    await saveChatHistory(channel, chatId, messages, convoSummary, historyVersion);
  } catch (err) {
    console.error('[Agent] Save history error:', err.message);
  }

  return replyText;
}

module.exports = {
  runAgent, onToolCall, getAgentMetrics, llmCreateWithFallback,
  _internals: {
    getTextLLMChain, dropDanglingToolTail, persistErrorHistory, classifyLlmError, capToolCall, FALLBACK_MESSAGES,
    FALLBACK_AI, FALLBACK_BUSY, FALLBACK_NO_CREDITS, FALLBACK_MODEL_REJECTED,
    FALLBACK_RATE_LIMIT, FALLBACK_MODEL_EMPTY, FALLBACK_NETWORK, FALLBACK_NO_PROVIDER,
    FALLBACK_LLM_GENERIC, FALLBACK_INTERNAL,
  },
};

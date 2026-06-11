'use strict';
const fs = require('fs');
const path = require('path');

// ───────────────────────────────────────────────────────────────────────────
// Tool registry — автозагрузка инструментов.
//
// Каждый файл в src/tools/ (кроме этого index.js) — самодостаточный инструмент,
// который экспортирует:
//
//   module.exports = {
//     definition: { type: 'function', function: { name, description, parameters } },
//     handler: async (args, context) => { ... },   // context = {channel, chatId, phone, clientName}
//   };
//
// Чтобы добавить инструмент — просто положите сюда новый файл. Registry сам его
// подхватит: ничего больше править не нужно (ни agent.js, ни этот файл).
// ───────────────────────────────────────────────────────────────────────────

const tools = [];          // массив OpenAI function-схем (definition.function)
const handlers = new Map(); // name → handler(args, context)

function isToolModule(mod) {
  return mod
    && mod.definition
    && mod.definition.function
    && typeof mod.definition.function.name === 'string'
    && typeof mod.handler === 'function';
}

function loadTools() {
  const dir = __dirname;
  const files = fs.readdirSync(dir).filter(
    (f) => f.endsWith('.js') && f !== 'index.js'
  );

  function register(mod, file) {
    const name = mod.definition.function.name;
    if (handlers.has(name)) {
      console.warn(`[Tools] Дубликат инструмента "${name}" в ${file} — пропущен`);
      return;
    }
    tools.push(mod.definition);
    handlers.set(name, mod.handler);
  }

  for (const file of files) {
    let mod;
    try {
      mod = require(path.join(dir, file));
    } catch (err) {
      console.error(`[Tools] Не удалось загрузить ${file}: ${err.message}`);
      continue;
    }
    // Файл может экспортировать один инструмент {definition, handler} ИЛИ группу { tools: [...] }.
    if (Array.isArray(mod && mod.tools)) {
      const valid = mod.tools.filter(isToolModule);
      if (!valid.length) { console.warn(`[Tools] Пропущен ${file}: нет валидных инструментов в tools[]`); continue; }
      for (const t of valid) register(t, file);
      continue;
    }
    if (!isToolModule(mod)) {
      console.warn(`[Tools] Пропущен ${file}: нет валидных { definition, handler }`);
      continue;
    }
    register(mod, file);
  }

  console.log(`[Tools] Загружено инструментов: ${tools.length} (${[...handlers.keys()].join(', ') || 'нет'})`);
}

loadTools();

// Инструменты режима БОССА: планирование, делегирование, управление штатом и
// процессами, рассылки, чтение всех планов. Code-level гейт — НЕ полагаемся на
// промпт: сотрудник (или посторонний) prompt-инъекцией не должен их вызвать.
// update_task намеренно НЕ здесь: он доступен и сотруднику (для своей задачи —
// внутренняя проверка владельца), и боссу (форс-режим над любой задачей).
const BOSS_ONLY = new Set([
  'create_project', 'revise_project', 'dispatch_task', 'assign_task',
  'manage_employees', 'message_employee', 'project_status', 'manage_scheduler',
  'manage_schedule',
  // Ассистентские фичи — личные инструменты владельца.
  'render_diagram', 'web_search', 'remember_fact', 'list_facts', 'forget_fact',
  'manage_notes', 'manage_todos',
]);

// Выполнить инструмент по имени. context = { channel, chatId, phone, clientName, role }.
async function executeToolCall(name, args, context = {}) {
  const handler = handlers.get(name);
  if (!handler) {
    return { success: false, message: `Unknown tool: ${name}` };
  }
  if (BOSS_ONLY.has(name) && context.role && context.role !== 'boss') {
    console.warn(`[Tools] Отказ: '${name}' доступен только боссу, роль='${context.role}' (${context.channel}:${context.chatId})`);
    return { success: false, message: 'Доступно только руководителю (роль босса).' };
  }
  return handler(args, context);
}

module.exports = { tools, executeToolCall, handlers, BOSS_ONLY };

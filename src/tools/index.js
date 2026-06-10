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

  for (const file of files) {
    let mod;
    try {
      mod = require(path.join(dir, file));
    } catch (err) {
      console.error(`[Tools] Не удалось загрузить ${file}: ${err.message}`);
      continue;
    }
    if (!isToolModule(mod)) {
      console.warn(`[Tools] Пропущен ${file}: нет валидных { definition, handler }`);
      continue;
    }
    const name = mod.definition.function.name;
    if (handlers.has(name)) {
      console.warn(`[Tools] Дубликат инструмента "${name}" в ${file} — пропущен`);
      continue;
    }
    tools.push(mod.definition);
    handlers.set(name, mod.handler);
  }

  console.log(`[Tools] Загружено инструментов: ${tools.length} (${[...handlers.keys()].join(', ') || 'нет'})`);
}

loadTools();

// Выполнить инструмент по имени. context = { channel, chatId, phone, clientName }.
async function executeToolCall(name, args, context) {
  const handler = handlers.get(name);
  if (!handler) {
    return { success: false, message: `Unknown tool: ${name}` };
  }
  return handler(args, context);
}

module.exports = { tools, executeToolCall, handlers };

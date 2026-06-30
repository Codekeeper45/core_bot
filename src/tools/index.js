'use strict';
const fs = require('fs');
const path = require('path');
const config = require('../config');

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

// Голосовые тулы прячем от LLM, когда озвучка выключена (config.TTS_ENABLED=false).
// Файлы остаются — включить обратно = TTS_ENABLED=1. См. также гейт в executeToolCall.
const VOICE_TOOLS = new Set(['say_voice', 'list_voices']);
if (!config.TTS_ENABLED) {
  for (let i = tools.length - 1; i >= 0; i--) {
    if (VOICE_TOOLS.has(tools[i].function.name)) tools.splice(i, 1);
  }
}

// Инструменты ТОЛЬКО для босса. По решению «убрать иерархию» оркестрация (планы,
// задачи, делегирование, чтение всех планов, рассылки) доступна ВСЕМ сотрудникам —
// поэтому здесь остаётся лишь то, что реально опасно дать каждому:
//   - manage_employees — добавить/удалить людей из общего реестра,
//   - performance_report — KPI/успеваемость по всем сотрудникам,
//   - manage_scheduler — общефирменные утренняя/вечерняя рассылки.
// Всё остальное (create_project, revise_project, assign_task, dispatch_task,
// project_status, message_employee, update_task + личные инструменты) — доступно
// и сотруднику. Code-level гейт: prompt-инъекция не обойдёт.
const BOSS_ONLY = new Set([
  'manage_employees', 'performance_report', 'manage_scheduler',
]);

// Подмножество тул-схем для роли: сотруднику не показываем boss-only инструменты
// (он их всё равно не вызовет — гейт ниже остаётся как defense-in-depth, но и
// схемы в промпт не уходят → экономия токенов и меньше путаницы у модели).
// Чистая функция: возвращает новый массив, исходный `tools` не мутирует.
function toolsForRole(role) {
  if (role === 'boss') return tools;
  return tools.filter((t) => !BOSS_ONLY.has(t.function.name));
}

// Выполнить инструмент по имени. context = { channel, chatId, phone, clientName, role }.
async function executeToolCall(name, args, context = {}) {
  const handler = handlers.get(name);
  if (!handler) {
    return { success: false, message: `Unknown tool: ${name}` };
  }
  if (VOICE_TOOLS.has(name) && !config.TTS_ENABLED) {
    return { success: false, message: 'Голосовые ответы временно отключены — отвечаю текстом.' };
  }
  if (BOSS_ONLY.has(name) && context.role && context.role !== 'boss') {
    console.warn(`[Tools] Отказ: '${name}' доступен только боссу, роль='${context.role}' (${context.channel}:${context.chatId})`);
    return { success: false, message: 'Доступно только руководителю (роль босса).' };
  }
  return handler(args, context);
}

module.exports = { tools, executeToolCall, handlers, BOSS_ONLY, toolsForRole };

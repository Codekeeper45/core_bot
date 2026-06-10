'use strict';

// ───────────────────────────────────────────────────────────────────────────
// ПРИМЕР ИНСТРУМЕНТА — эталон формата для tool registry.
//
// Это рабочий, но демонстрационный инструмент. Скопируйте этот файл, дайте ему
// своё имя и логику — registry (src/tools/index.js) подхватит его автоматически,
// без правок agent.js или каких-либо других файлов.
//
// УДАЛИТЕ этот файл, когда он больше не нужен.
//
// Контракт tool-файла:
//   module.exports = {
//     definition: { type:'function', function:{ name, description, parameters } },
//     handler: async (args, context) => result,   // result сериализуется в JSON и уходит модели
//   };
//   context = { channel, chatId, phone, clientName }
// ───────────────────────────────────────────────────────────────────────────

const definition = {
  type: 'function',
  function: {
    name: 'get_current_time',
    description:
      'Возвращает текущие дату и время в UTC. Пример инструмента — показывает, как ядро '
      + 'автоматически подключает новый файл из src/tools/ без правок другого кода.',
    parameters: {
      type: 'object',
      properties: {
        format: {
          type: 'string',
          enum: ['iso', 'human'],
          description: 'iso = машинный формат (2026-01-01T12:00:00Z), human = читаемый.',
        },
      },
      required: [],
    },
  },
};

async function handler(args /* , context */) {
  const now = new Date();
  if (args && args.format === 'human') {
    return { time: now.toUTCString() };
  }
  return { time: now.toISOString() };
}

module.exports = { definition, handler };

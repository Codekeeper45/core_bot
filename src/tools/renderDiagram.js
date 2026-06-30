'use strict';
// Визуализация: Mermaid-код → PNG через публичный kroki.io → картинка в чат.
// Без ключей. Доступен боссу и сотруднику.
const { deflateSync } = require('node:zlib');
const notifier = require('../services/notifier');

const definition = {
  type: 'function',
  function: {
    name: 'render_diagram',
    description:
      'Нарисовать диаграмму по Mermaid-коду и отправить картинкой в чат. Используй, когда нужно '
      + 'визуализировать процесс, структуру, план, таймлайн, оргсхему, воронку. Поддерживает '
      + 'flowchart, sequence, class, mindmap, timeline, gantt, er, pie. Передавай КОРРЕКТНЫЙ '
      + 'Mermaid-код. После отправки кратко подтверди.',
    parameters: {
      type: 'object',
      properties: {
        mermaid_code: { type: 'string', description: 'Корректный Mermaid-код диаграммы.' },
        caption: { type: 'string', description: 'Короткая подпись к картинке (опционально).' },
      },
      required: ['mermaid_code'],
    },
  },
};

async function handler(args, context = {}) {
  if (!args.mermaid_code) return { success: false, message: 'Нужен mermaid_code.' };
  try {
    const encoded = deflateSync(Buffer.from(String(args.mermaid_code))).toString('base64url');
    const url = `https://kroki.io/mermaid/png/${encoded}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) {
      return { success: false, message: `Не удалось отрисовать диаграмму (kroki.io: ${res.status}). Проверь синтаксис Mermaid.` };
    }
    const buffer = Buffer.from(await res.arrayBuffer());
    const sent = await notifier.deliver(context.channel, context.chatId, '',
      { kind: 'image', buffer, caption: args.caption || '' });
    if (!sent) return { success: false, message: 'Диаграмма отрисована, но не удалось отправить в чат.' };
    return { success: true, note: 'Диаграмма отправлена картинкой.' };
  } catch (err) {
    return { success: false, message: `Не удалось нарисовать диаграмму: ${err.message}. Попробуй упростить схему.` };
  }
}

module.exports = { definition, handler };

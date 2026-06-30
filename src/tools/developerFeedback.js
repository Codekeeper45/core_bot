'use strict';

const { submitDeveloperEvent } = require('../services/developerFeedback');

const definition = {
  type: 'function',
  function: {
    name: 'send_developer_feedback',
    description: 'Передаёт разработчику баг, идею, жалобу или пожелание пользователя. Используй только по явной просьбе пользователя связаться с разработчиком.',
    parameters: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: ['bug', 'idea', 'complaint'] },
        message: { type: 'string', description: 'Суть обращения своими словами без секретов.' },
      },
      required: ['type', 'message'],
    },
  },
};

const recent = new Map();
function allow(key) {
  const now = Date.now();
  const live = (recent.get(key) || []).filter((ts) => now - ts < 60 * 60 * 1000);
  if (live.length >= 5) return false;
  live.push(now);
  recent.set(key, live);
  return true;
}

async function handler(args, context = {}) {
  const message = String(args.message || '').trim();
  if (!message) return { success: false, reason: 'empty_message' };
  const key = `${context.channel || '?'}:${context.chatId || '?'}`;
  if (!allow(key)) return { success: false, reason: 'rate_limited', message: 'Лимит обратной связи: 5 сообщений в час.' };
  const result = await submitDeveloperEvent({
    kind: 'feedback',
    severity: args.type === 'bug' ? 'warning' : 'info',
    message: `[${args.type || 'idea'}] ${message}`,
    channel: context.channel,
    chatId: context.chatId,
    actorName: context.clientName,
    includeHistory: true,
  });
  if (result.success) return { success: true, event_id: result.event_id, message: 'Обратная связь передана разработчику.' };
  return { success: true, queued: true, event_id: result.event_id, message: 'Обратная связь сохранена и будет доставлена разработчику повторно.' };
}

module.exports = { definition, handler };


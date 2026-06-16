'use strict';
const { findEmployeeByContact, getLatestProjectForEmployee, findBossRoute } = require('../services/mysql');
const notifier = require('../services/notifier');
const config = require('../config');

const definition = {
  type: 'function',
  function: {
    name: 'message_boss',
    description:
      'Переслать боссу сообщение от СОТРУДНИКА: вопрос, проблему, возражение или просьбу, которые '
      + 'требуют решения руководителя и не являются простым статус-апдейтом. Используй в режиме '
      + 'сотрудника, когда не можешь ответить сам. После вызова коротко подтверди сотруднику, что '
      + 'передал руководителю.',
    parameters: {
      type: 'object',
      properties: {
        message: { type: 'string', description: 'Суть сообщения сотрудника для босса (своими словами, по делу).' },
        kind: {
          type: 'string',
          enum: ['question', 'problem', 'objection', 'request'],
          description: 'Тип обращения.',
        },
      },
      required: ['message'],
    },
  },
};

async function handler(args, context = {}) {
  const phoneDigits = String(context.phone || '').replace(/\D/g, '');
  const emp = await findEmployeeByContact(context.channel, context.chatId)
    || (phoneDigits ? await findEmployeeByContact(context.channel, phoneDigits) : null);
  if (!emp) return { success: false, message: 'Отправитель не найден в реестре сотрудников.' };

  const kindRu = { question: 'Вопрос', problem: 'Проблема', objection: 'Возражение', request: 'Просьба' }[args.kind] || 'Сообщение';

  // Маршрут: (1) владелец последнего проекта сотрудника → (2) директор из реестра →
  // (3) BOSS_CONTACTS → (4) MANAGER_*. Пробуем по очереди, пока доставка не пройдёт.
  const proj = await getLatestProjectForEmployee(emp.id);
  const routes = [];
  if (proj && proj.owner_chat_id) {
    routes.push({ channel: proj.owner_channel, contact: proj.owner_chat_id, label: `по плану «${proj.title}»` });
  }
  const boss = await findBossRoute();
  if (boss) routes.push({ channel: boss.channel, contact: boss.contact, label: '' });
  for (const d of config.BOSS_CONTACTS) routes.push({ channel: 'whatsapp', contact: d, label: '' });
  if (config.MANAGER_TG) routes.push({ channel: 'telegram', contact: config.MANAGER_TG, label: '' });
  if (config.MANAGER_WA) routes.push({ channel: 'whatsapp', contact: config.MANAGER_WA, label: '' });

  for (const r of routes) {
    const where = r.label ? ` ${r.label}` : '';
    const text = `📨 ${kindRu} от ${emp.name} (${emp.roles})${where}:\n${args.message}`;
    const ok = await notifier.deliver(r.channel, r.contact, text);
    if (ok) {
      return { success: true, routed_to: 'boss', project: proj ? proj.title : null, note: 'передано руководителю' };
    }
  }
  // Никуда не дошло — честно говорим (без ложного «передал»).
  return {
    success: false,
    reason: 'no_route',
    message: 'Не смог передать руководителю (нет доступного контакта/доставка не прошла). Сообщи сотруднику честно или попробуй позже.',
  };
}

module.exports = { definition, handler };

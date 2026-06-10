'use strict';
const { findEmployeeByContact, getLatestProjectForEmployee } = require('../services/mysql');
const notifier = require('../services/notifier');

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

  const proj = await getLatestProjectForEmployee(emp.id);
  if (!proj) return { success: false, message: 'Не найден план/босс для маршрутизации.' };

  const kindRu = { question: 'Вопрос', problem: 'Проблема', objection: 'Возражение', request: 'Просьба' }[args.kind] || 'Сообщение';
  const text = `📨 ${kindRu} от ${emp.name} (${emp.roles}) по плану «${proj.title}»:\n${args.message}`;
  const ok = await notifier.deliver(proj.owner_channel, proj.owner_chat_id, text);

  return {
    success: ok,
    routed_to: 'boss',
    project: proj.title,
    note: ok ? 'передано руководителю' : 'не удалось доставить боссу',
  };
}

module.exports = { definition, handler };

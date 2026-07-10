'use strict';
const { findEmployeeByContact, getTask, getProject, findBossRoute } = require('../services/mysql');
const notifier = require('../services/notifier');
const config = require('../config');
const { shouldSignOutbound } = require('../services/senderIdentity');

const definition = {
  type: 'function',
  function: {
    name: 'message_boss',
    description:
      'Эскалация наверх: передать руководителю вопрос, проблему, возражение или просьбу сотрудника, '
      + 'которые требуют решения руководителя и не являются простым статус-апдейтом. Зови, когда сам '
      + 'не можешь решить вопрос. После вызова коротко подтверди сотруднику, что передал руководителю '
      + '(если инструмент вернул success:false — скажи честно, что передать не удалось).',
    parameters: {
      type: 'object',
      properties: {
        message: { type: 'string', description: 'Суть сообщения сотрудника для босса (своими словами, по делу).' },
        kind: {
          type: 'string',
          enum: ['question', 'problem', 'objection', 'request'],
          description: 'Тип обращения.',
        },
        task_id: { type: 'integer', description: 'ID задачи, если обращение относится к конкретной задаче.' },
        project_id: { type: 'integer', description: 'ID плана, если обращение относится к плану целиком.' },
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

  // Никогда не угадываем контекст по «последнему» проекту: он часто не тот.
  // Точный маршрут появляется только из явного task_id/project_id; общий вопрос
  // сразу идёт директору/контактам босса.
  let proj = null;
  if (args.task_id != null) {
    const task = await getTask(args.task_id);
    if (!task) return { success: false, reason: 'task_not_found', message: `Задача #${args.task_id} не найдена.` };
    if (args.project_id != null && Number(args.project_id) !== Number(task.project_id)) {
      return { success: false, reason: 'context_mismatch', message: 'task_id и project_id относятся к разным планам.' };
    }
    proj = await getProject(task.project_id);
  } else if (args.project_id != null) {
    proj = await getProject(args.project_id);
    if (!proj) return { success: false, reason: 'project_not_found', message: `План #${args.project_id} не найден.` };
  }

  // Маршрут: (1) владелец явно указанного проекта → (2) директор из реестра →
  // (3) BOSS_CONTACTS → (4) MANAGER_*. Пробуем по очереди, пока доставка не пройдёт.
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
    const from = shouldSignOutbound(context) ? ` от ${emp.name} (${emp.roles})` : '';
    const text = `📨 ${kindRu}${from}${where}:\n${args.message}`;
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

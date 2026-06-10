'use strict';
const { findEmployees } = require('../services/mysql');
const notifier = require('../services/notifier');
const { handleToolDbError } = require('../utils/toolError');

// ─── Tool definition ─────────────────────────────────────────────────────────
const definition = {
  type: 'function',
  function: {
    name: 'message_employee',
    description:
      'Быстро отправить сообщение сотруднику(ам): напоминание, просьбу, информацию — НЕ привязанное к '
      + 'рабочей задаче (для задач есть dispatch_task). Адресат указывается в to: id, имя или роль '
      + '(напр. «Директор», «кладовщик», «Мякота»). По умолчанию пишет ОДНОМУ (первому подходящему '
      + 'с контактом). Чтобы написать ВСЕМ по роли (напр. всем кладовщикам) — поставь to_all=true. '
      + 'Инструмент режима БОССА.',
    parameters: {
      type: 'object',
      properties: {
        to: {
          type: 'string',
          description: 'Кому: id / имя / роль сотрудника (напр. «Директор», «кладовщик», «5»).',
        },
        message: {
          type: 'string',
          description: 'Текст сообщения сотруднику (по делу, без воды).',
        },
        to_all: {
          type: 'boolean',
          description: 'true = отправить ВСЕМ активным сотрудникам, подходящим под to (рассылка по роли). По умолчанию false — одному.',
        },
      },
      required: ['to', 'message'],
    },
  },
};

async function handler(args) {
  try {
    const to = String(args.to || '').trim();
    const message = String(args.message || '').trim();
    if (!to || !message) {
      return { success: false, message: 'Нужно указать to (кому) и message (текст).' };
    }

    const matches = await findEmployees(to);
    const withContact = matches.filter((m) => m.contact);
    if (!withContact.length) {
      return {
        success: false,
        reason: 'no_recipient',
        message: `Не нашёл сотрудника с контактом по запросу «${to}».`,
      };
    }

    const targets = args.to_all ? withContact : [withContact[0]];
    const sent_to = [];
    for (const emp of targets) {
      const ok = await notifier.deliver(emp.channel || 'whatsapp', emp.contact, message);
      sent_to.push({ id: emp.id, name: emp.name, sent: ok });
    }
    const okCount = sent_to.filter((r) => r.sent).length;

    return {
      success: okCount > 0,
      count: okCount,
      total: targets.length,
      sent_to,
      note: okCount === targets.length
        ? 'доставлено'
        : `доставлено ${okCount} из ${targets.length} (см. sent_to)`,
    };
  } catch (err) {
    return handleToolDbError(err);
  }
}

module.exports = { definition, handler };

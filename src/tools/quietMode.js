'use strict';
// Тихий режим «не пиши мне первым»: пока включён, бот НЕ отправляет владельцу
// проактивных сообщений (напоминания/будильники/проверки по расписанию, утренние/
// вечерние сводки). На ОТВЕТЫ в диалоге не влияет — спросишь, он ответит.
// Персональный: у каждого свой (по chat_id). Доступен боссу и сотруднику.
const { setQuiet, clearQuiet, getQuiet } = require('../services/mysql');
const { toUtc, fmtUtc } = require('../utils/scheduleTime');
const { localNow } = require('../utils/localTime');
const config = require('../config');

const MAX_MIN = 7 * 24 * 60; // потолок авто-таймера — неделя

function utcToLocalStr(v) {
  if (!v) return null;
  return localNow(toUtc(v)).toISOString().slice(0, 16).replace('T', ' ');
}

const definition = {
  type: 'function',
  function: {
    name: 'quiet_mode',
    description:
      'Тихий режим — «не пиши мне первым / замолчи / пауза / стоп / не беспокой». Пока включён, ты '
      + 'НЕ шлёшь этому человеку ничего ПЕРВЫМ (напоминания, будильники, проверки, утренние/вечерние '
      + 'сводки молчат). На прямые сообщения ты по-прежнему отвечаешь. Действия: on (включить — '
      + 'насовсем или на minutes), off (снова можно писать — «продолжай», «можешь писать»), '
      + 'status (узнать, включён ли). Персональный: касается только того, кто просит.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['on', 'off', 'status'], description: 'on — замолчать; off — снова можно писать первым; status — проверить.' },
        minutes: { type: 'integer', description: 'Только для on: на сколько минут замолчать (потом сам включусь). Без minutes — бессрочно, пока не скажут «продолжай».' },
      },
      required: ['action'],
    },
  },
};

async function handler(args = {}, context = {}) {
  const phone = String(context.phone || '').replace(/\D/g, '') || null;
  if (args.action === 'on') {
    let untilUtc = null;
    let untilLocal = null;
    if (args.minutes != null) {
      const m = Number(args.minutes);
      if (!Number.isInteger(m) || m < 1 || m > MAX_MIN) {
        return { success: false, message: `minutes должен быть целым 1..${MAX_MIN} (до недели).` };
      }
      const until = new Date(Date.now() + m * 60000);
      untilUtc = fmtUtc(until);
      untilLocal = utcToLocalStr(untilUtc);
    }
    await setQuiet(context.channel, context.chatId, phone, untilUtc);
    return {
      success: true,
      quiet: true,
      until_local: untilLocal,
      note: untilLocal
        ? `Молчу до ${untilLocal} (локальное время) — проактивно не пишу. Скажи «продолжай», чтобы снять раньше.`
        : 'Молчу — первым ничего не пишу, пока не скажешь «продолжай». На вопросы отвечаю как обычно.',
    };
  }

  if (args.action === 'off') {
    const was = await clearQuiet(context.channel, context.chatId);
    return { success: true, quiet: false, note: was ? 'Снова на связи — буду писать по расписанию.' : 'Тихий режим и так был выключен.' };
  }

  if (args.action === 'status') {
    const row = await getQuiet(context.channel, context.chatId);
    const active = !!(row && Number(row.active));
    return {
      success: true,
      quiet: active,
      until_local: active ? utcToLocalStr(row.quiet_until) : null,
      note: active
        ? (row.quiet_until ? `Тихий режим включён до ${utcToLocalStr(row.quiet_until)}.` : 'Тихий режим включён (бессрочно).')
        : 'Тихий режим выключен — пишу по расписанию.',
    };
  }

  return { success: false, message: `Неизвестное действие: ${args.action}` };
}

module.exports = { definition, handler, _internals: { MAX_MIN } };

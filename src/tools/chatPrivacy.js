'use strict';
// Приватность ТЕКУЩЕГО чата для общего поиска памяти (recall/recall_by_date
// scope=all). По умолчанию чат 'work' — его находят все. 'private' — чат видят
// только его владелец и босс. Личная граница: босс об изменении не уведомляется.
const { setChatPrivacy, getChatPrivacy } = require('../services/mysql');
const { handleToolDbError } = require('../utils/toolError');

const definition = {
  type: 'function',
  function: {
    name: 'manage_chat_privacy',
    description:
      'Приватность ТЕКУЩЕГО чата для общего поиска памяти (recall scope=all). По умолчанию чат '
      + '«work» — его переписку находят все при поиске по всем чатам. set_private — скрыть этот чат '
      + 'от чужого поиска (его видят только владелец и руководитель); set_work — вернуть в общий '
      + 'доступ; status — узнать текущий режим. Действует только на чат, из которого вызван. '
      + 'Вызывай, когда человек просит «сделай наш чат приватным / не показывай мою переписку другим».',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['set_private', 'set_work', 'status'] },
      },
      required: ['action'],
    },
  },
};

async function handler(args, context = {}) {
  try {
    if (args.action === 'status') {
      const privacy = await getChatPrivacy(context.channel, context.chatId);
      return {
        success: true,
        privacy,
        note: privacy === 'private'
          ? 'Чат приватный: в общем поиске (scope=all) его видят только владелец и руководитель.'
          : 'Чат рабочий (по умолчанию): в общем поиске он виден всем.',
      };
    }
    if (args.action === 'set_private' || args.action === 'set_work') {
      const privacy = await setChatPrivacy(context.channel, context.chatId, args.action === 'set_private' ? 'private' : 'work');
      return {
        success: true,
        privacy,
        note: privacy === 'private'
          ? 'Готово: чат скрыт из общего поиска. Владелец и руководитель по-прежнему могут искать по нему.'
          : 'Готово: чат снова виден в общем поиске по всем чатам.',
      };
    }
    return { success: false, reason: 'invalid_action' };
  } catch (err) {
    return handleToolDbError(err);
  }
}

module.exports = { definition, handler };

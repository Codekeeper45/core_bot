'use strict';

const config = require('../config');
const {
  createPolicy, listPolicies, setPolicyStatus,
} = require('../services/mysql');
const notifier = require('../services/notifier');
const { handleToolDbError } = require('../utils/toolError');

const definition = {
  type: 'function',
  function: {
    name: 'manage_policy',
    description:
      'Управление ОБЩИМИ правилами поведения бота. propose — предложить правило для всех; '
      + 'руководитель/администратор активирует его сразу, предложение сотрудника ждёт утверждения. '
      + 'list — показать active/pending/rejected; approve/reject — только руководитель или администратор; '
      + 'replace — создать новую активную версию правила с тем же policy_key. Личные предпочтения '
      + 'сохраняй через remember_fact, не через этот инструмент.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['propose', 'list', 'approve', 'reject', 'replace'] },
        policy_key: {
          type: 'string',
          description: 'Стабильный ключ темы, например response.style или price.internal_default.',
        },
        policy_text: { type: 'string', description: 'Одно непротиворечивое правило.' },
        id: { type: 'integer', description: 'ID предложения для approve/reject.' },
        status: { type: 'string', enum: ['active', 'pending', 'rejected', 'superseded'] },
      },
      required: ['action'],
    },
  },
};

function digits(value) {
  return String(value || '').replace(/\D/g, '');
}

function isAdmin(context = {}) {
  if (context.role === 'boss') return true;
  const ids = [digits(context.chatId), digits(context.phone)].filter(Boolean);
  return config.POLICY_ADMIN_CONTACTS.some((id) => ids.includes(id));
}

async function handler(args = {}, context = {}) {
  try {
    const action = String(args.action || '');
    const admin = isAdmin(context);
    const actor = context.clientName || context.phone || 'Сотрудник';

    if (action === 'list') {
      const rows = await listPolicies(args.status || null, 200);
      return {
        success: true,
        count: rows.length,
        policies: rows.map((row) => ({
          id: row.id,
          policy_key: row.policy_key,
          policy_text: row.policy_text,
          status: row.status,
          version: row.version,
          created_by: row.created_by,
          approved_by: row.approved_by,
        })),
        completeness: { complete: true, returned: rows.length },
      };
    }

    if (action === 'approve' || action === 'reject') {
      if (!admin) {
        return { success: false, reason: 'not_allowed', message: 'Утверждать общие правила может только руководитель или администратор.' };
      }
      if (!Number.isInteger(Number(args.id)) || Number(args.id) <= 0) {
        return { success: false, reason: 'id_required', message: 'Нужен положительный id правила.' };
      }
      const result = await setPolicyStatus(Number(args.id), action === 'approve' ? 'active' : 'rejected', actor);
      if (!result) return { success: false, reason: 'not_found', message: 'Правило не найдено.' };
      return { success: true, ...result, note: action === 'approve' ? 'Общее правило утверждено.' : 'Предложение отклонено.' };
    }

    if (action === 'propose' || action === 'replace') {
      if (!args.policy_key || !args.policy_text) {
        return { success: false, reason: 'policy_required', message: 'Нужны policy_key и policy_text.' };
      }
      if (action === 'replace' && !admin) {
        return { success: false, reason: 'not_allowed', message: 'Заменять действующее правило может только руководитель или администратор.' };
      }
      const status = admin ? 'active' : 'pending';
      const result = await createPolicy({
        policyKey: args.policy_key,
        policyText: args.policy_text,
        status,
        channel: context.channel,
        chatId: context.chatId,
        createdBy: actor,
        sourceMessageId: context.sourceMessageId,
        approvedBy: admin ? actor : null,
      });
      if (!admin) {
        notifier.notifyBossAboutChange(
          context,
          `Предложено общее правило «${result.policyKey}»: ${String(args.policy_text).slice(0, 500)}`
        ).catch(() => {});
      }
      return {
        success: true,
        ...result,
        note: admin
          ? 'Общее правило активировано.'
          : 'Предложение сохранено и ждёт утверждения руководителем или администратором.',
      };
    }

    return { success: false, reason: 'invalid_action', message: 'Неизвестное действие manage_policy.' };
  } catch (err) {
    return handleToolDbError(err);
  }
}

module.exports = { definition, handler, _internals: { isAdmin } };

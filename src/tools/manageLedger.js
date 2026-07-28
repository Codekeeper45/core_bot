'use strict';

const {
  ledgerOpenAccount, ledgerAddEntry, ledgerGet,
} = require('../services/mysql');
const { localBoundaryToUtc, localStamp } = require('../utils/localTime');
const { handleToolDbError } = require('../utils/toolError');

const definition = {
  type: 'function',
  function: {
    name: 'manage_ledger',
    description:
      'Журнал денежных остатков и долгов с проверяемой историей. open — создать счёт; '
      + 'add — добавить проводку (положительная увеличивает баланс, отрицательная уменьшает); '
      + 'balance — текущий баланс; history — операции. Используй вместо remember_fact/list_facts '
      + 'для долгов, расходов и других изменяемых сумм. Никогда не угадывай начальный баланс.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['open', 'add', 'balance', 'history'] },
        account_key: { type: 'string', description: 'Стабильный ключ, например ruslan_debt.' },
        title: { type: 'string', description: 'Название счёта для open.' },
        currency: { type: 'string', description: 'Валюта, по умолчанию KZT.' },
        amount: { type: 'number', description: 'Сумма проводки со знаком для add.' },
        note: { type: 'string', description: 'Основание операции.' },
        effective_at: { type: 'string', description: 'Дата/время компании, опционально.' },
        limit: { type: 'integer', description: 'Операций в history, 1–500.' },
      },
      required: ['action', 'account_key'],
    },
  },
};

async function handler(args = {}, context = {}) {
  try {
    const action = String(args.action || '');
    const key = String(args.account_key || '').trim();
    if (!key) return { success: false, reason: 'account_required', message: 'Нужен account_key.' };

    if (action === 'open') {
      if (!String(args.title || '').trim()) {
        return { success: false, reason: 'title_required', message: 'Для open нужен title.' };
      }
      const account = await ledgerOpenAccount({
        accountKey: key,
        title: args.title,
        currency: args.currency || 'KZT',
        actorName: context.clientName,
      });
      return { success: true, account, note: 'Денежный счёт создан. Добавь подтверждённый начальный остаток отдельной проводкой.' };
    }

    if (action === 'add') {
      const amount = Number(args.amount);
      if (!Number.isFinite(amount) || amount === 0) {
        return { success: false, reason: 'invalid_amount', message: 'amount должен быть ненулевым числом со знаком.' };
      }
      let effectiveAt = null;
      if (args.effective_at) {
        const parsed = localBoundaryToUtc(args.effective_at, false);
        if (!parsed) return { success: false, reason: 'bad_date', message: 'Не понял effective_at.' };
        effectiveAt = parsed.toISOString().slice(0, 19).replace('T', ' ');
      }
      const added = await ledgerAddEntry({
        accountKey: key,
        amount,
        note: args.note || null,
        effectiveAt,
        actorName: context.clientName,
        sourceMessageId: context.sourceMessageId,
      });
      if (!added) return { success: false, reason: 'account_not_found', message: 'Счёт не найден. Сначала создай его через open.' };
      const state = await ledgerGet(key, 10);
      return {
        success: true,
        entry_id: added.id,
        balance: state.balance,
        currency: state.account.currency,
        evidence: { source: 'bot_ledger_entries', entry_id: added.id },
        note: `Проводка записана. Текущий баланс: ${state.balance} ${state.account.currency}.`,
      };
    }

    if (action === 'balance' || action === 'history') {
      const state = await ledgerGet(key, action === 'history' ? args.limit : 10);
      if (!state) return { success: false, reason: 'account_not_found', message: 'Счёт не найден.' };
      return {
        success: true,
        account: {
          account_key: state.account.account_key,
          title: state.account.title,
          currency: state.account.currency,
        },
        balance: state.balance,
        entries: action === 'history'
          ? state.entries.map((entry) => ({
            ...entry,
            effective_at_local: localStamp(entry.effective_at),
          }))
          : undefined,
        evidence: { source: 'bot_ledger_entries', entry_count: state.entries.length },
        completeness: {
          complete: action !== 'history' || state.entries.length < Math.max(1, Math.min(Number(args.limit) || 50, 500)),
          returned: action === 'history' ? state.entries.length : 0,
        },
      };
    }

    return { success: false, reason: 'invalid_action', message: 'Неизвестное действие manage_ledger.' };
  } catch (err) {
    return handleToolDbError(err);
  }
}

module.exports = { definition, handler };

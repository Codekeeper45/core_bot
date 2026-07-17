'use strict';
// Финансовая аналитика (замена рутины экономиста): по присланной выгрузке 1С
// (Excel/CSV) считаем доходы/расходы, баланс за месяц и итоги по колонкам
// (дебет/кредит и любые суммы). Цифры считает детерминированный сервис
// financeAnalyzer, а НЕ модель — поэтому они точные. Формат 1С заранее
// неизвестен: модель смотрит распарсенный образец (виден в контексте после
// присланного файла) и передаёт маппинг колонок.
const { analyzeFinance } = require('../services/financeAnalyzer');
const docBinaryStash = require('../services/docBinaryStash');
const docStash = require('../services/docStash');
const { handleToolDbError } = require('../utils/toolError');

const definition = {
  type: 'function',
  function: {
    name: 'financial_analysis',
    description:
      'Финансовый разбор присланной выгрузки 1С (Excel/CSV): доходы (заработано), расходы (потрачено), '
      + 'баланс, помесячная разбивка и итоги по каждой числовой колонке (дебет/кредит и любые суммы). '
      + 'Цифры считаются точно, не на глаз. Сначала посмотри распарсенный файл в контексте, определи '
      + 'колонки и передай mapping. file="last" или имя присланного файла. mapping — ОДИН из режимов: '
      + '(1) income_col + expense_col — две колонки сумм (напр. Кредит/Дебет, Приход/Расход); '
      + '(2) amount_col + type_col + income_when[] + expense_when[] — одна сумма и колонка типа операции '
      + '(income_when/expense_when — слова-признаки прихода/расхода); '
      + '(3) amount_col + sign_rule (positive_income|negative_income) — одна колонка со знаком. '
      + 'Колонки задаются именем из шапки, буквой Excel (A,B,C) или номером (0-based). Опц. date_col — '
      + 'колонка даты для помесячной разбивки; header_row — номер строки шапки (по умолч. 1); sheet — лист.',
    parameters: {
      type: 'object',
      properties: {
        file: { type: 'string', description: 'Имя присланного файла или "last" (последний). По умолчанию last.' },
        mapping: {
          type: 'object',
          description: 'Соответствие колонок. Заполни ОДИН из трёх режимов (см. описание инструмента).',
          properties: {
            sheet: { type: 'string', description: 'Имя листа (по умолчанию первый).' },
            header_row: { type: 'integer', description: 'Номер строки с заголовками (1-based, по умолч. 1).' },
            income_col: { type: 'string', description: 'Режим 1: колонка доходов/прихода/кредита.' },
            expense_col: { type: 'string', description: 'Режим 1: колонка расходов/списаний/дебета.' },
            amount_col: { type: 'string', description: 'Режимы 2/3: колонка суммы.' },
            type_col: { type: 'string', description: 'Режим 2: колонка типа операции.' },
            income_when: { type: 'array', items: { type: 'string' }, description: 'Режим 2: слова-признаки дохода (напр. ["приход","поступление","кредит"]).' },
            expense_when: { type: 'array', items: { type: 'string' }, description: 'Режим 2: слова-признаки расхода (напр. ["расход","списание","дебет"]).' },
            sign_rule: { type: 'string', enum: ['positive_income', 'negative_income'], description: 'Режим 3: положительные суммы — доход или расход.' },
            date_col: { type: 'string', description: 'Опц.: колонка даты для помесячной разбивки.' },
          },
        },
      },
      required: ['mapping'],
    },
  },
};

async function handler(args = {}, context = {}) {
  try {
    const wanted = String(args.file || 'last').trim() || 'last';
    const mapping = args.mapping && typeof args.mapping === 'object' ? args.mapping : null;
    if (!mapping) return { success: false, reason: 'no_mapping', message: 'Нужен mapping колонок (см. описание инструмента).' };

    // Источник: сначала оригинальный бинарник (Excel), иначе распарсенный текст
    // (CSV или таблица после рестарта бота — работает, хоть и грубее).
    let input = null;
    const bin = docBinaryStash.get(context.channel, context.chatId, wanted);
    if (bin) input = { buffer: bin.buffer };
    else {
      const txt = docStash.get(context.channel, context.chatId, wanted);
      if (txt) input = { text: txt.text };
    }
    if (!input) {
      return { success: false, reason: 'not_in_stash', message: 'Не вижу эту выгрузку (истёк срок хранения или бот перезапускался). Пришли файл ещё раз и повтори.' };
    }

    let result;
    try {
      result = analyzeFinance(input, mapping);
    } catch (err) {
      return { success: false, reason: 'parse_failed', message: `Не удалось разобрать файл: ${err.message}. Проверь, что это Excel/CSV выгрузка.` };
    }
    if (result.error) {
      return { success: false, reason: result.error, message: result.message, columns: result.columns };
    }

    return {
      success: true,
      source: bin ? bin.fileName : (wanted === 'last' ? 'последний файл' : wanted),
      mode: result.mode,
      sheet: result.sheet,
      income: result.income,
      expense: result.expense,
      balance: result.balance,
      by_month: result.by_month,
      column_totals: result.column_totals,
      rows_used: result.rows_used,
      rows_skipped: result.rows_skipped,
      currency: 'KZT',
      note: 'income = заработано/приход, expense = потрачено/расход, balance = income − expense. '
        + 'column_totals — суммы по каждой колонке (в т.ч. дебет/кредит). Проверь колонки, если баланс выглядит странно.',
    };
  } catch (err) {
    return handleToolDbError(err);
  }
}

module.exports = { definition, handler };

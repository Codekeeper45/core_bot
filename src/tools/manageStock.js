'use strict';
// Учёт остатков склада. Доступен ВСЕМ (не в BOSS_ONLY): смотреть и менять остатки могут
// и босс, и сотрудники (без иерархии). Удаление — модель сначала подтверждает у человека.
const {
  stockSearch, stockList, stockGetById, stockGetByKey,
  stockUpsertSet, stockAdjust, stockRemove, stockRename,
} = require('../services/mysql');
const { normKey } = require('../utils/stockKey');
const { handleToolDbError } = require('../utils/toolError');

const DEFAULT_LOCATION = 'Нижний';

// Аккуратное число: 68 вместо 68.000, 1.5 вместо 1.500.
function fmtQty(q) {
  const n = Number(q);
  return Number.isInteger(n) ? String(n) : String(n).replace(/\.?0+$/, '');
}
function rowOut(r) {
  return { id: r.id, name: r.name, qty: Number(r.qty), unit: r.unit, location: r.location };
}

// Найти позицию для мутации: по id, либо по точному ключу в указанном складе, либо
// поиском. Возвращает { rows } — 0 / 1 / много совпадений.
async function resolveTarget(args) {
  if (args.id) {
    const r = await stockGetById(args.id);
    return { rows: r ? [r] : [] };
  }
  const name = String(args.name || '').trim();
  if (!name) return { rows: [] };
  if (args.location) {
    const exact = await stockGetByKey(args.location, normKey(name));
    if (exact) return { rows: [exact] };
  }
  const matches = await stockSearch(name, args.location || null, 10);
  // Если среди совпадений есть точное по ключу — берём только его (снимает неоднозначность).
  const key = normKey(name);
  const exactAll = matches.filter((m) => normKey(m.name) === key);
  return { rows: exactAll.length === 1 ? exactAll : matches };
}

function ambiguous(rows) {
  return {
    success: false, reason: 'ambiguous',
    candidates: rows.slice(0, 10).map(rowOut),
    message: `Нашёл несколько позиций (${rows.length}). Уточни, какую именно (по id или точному названию/складу).`,
  };
}

const definition = {
  type: 'function',
  function: {
    name: 'manage_stock',
    description:
      'Учёт остатков склада (лотки, решётки, пескобетон и т.д.). Смотреть и менять может любой. '
      + 'Действия: search — найти позиции и их остаток («есть ли ДН200 аквасток», «остаток лотков»); '
      + 'list — список позиций склада; adjust — приход(+)/расход(−) («пришло 50», «отгрузили 30»); '
      + 'set — установить точный остаток; add — добавить новую позицию; remove — удалить позицию '
      + '(СНАЧАЛА подтверди у человека); rename — переименовать. Склад указывай в location '
      + '(Нижний/Покровка/Верхний); по умолчанию Нижний. Остаток бери ТОЛЬКО из ответа инструмента, '
      + 'не выдумывай. Если позиция найдена неоднозначно — уточни, не угадывай.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['search', 'list', 'adjust', 'set', 'add', 'remove', 'rename'], description: 'Что сделать.' },
        query: { type: 'string', description: 'search: что искать (бренд/ДН/Н/тип), напр. «аквасток дн200».' },
        name: { type: 'string', description: 'Наименование позиции (для set/adjust/add/remove/rename, если не задан id).' },
        id: { type: 'integer', description: 'id позиции (точная адресация для set/adjust/remove/rename).' },
        qty: { type: 'number', description: 'set/add: точный остаток.' },
        delta: { type: 'number', description: 'adjust: изменение остатка. Приход +N, расход −N.' },
        unit: { type: 'string', description: 'Единица (по умолчанию «шт»).' },
        location: { type: 'string', description: 'Склад: Нижний (умолч.) / Покровка / Верхний.' },
        new_name: { type: 'string', description: 'rename: новое наименование.' },
      },
      required: ['action'],
    },
  },
};

async function handler(args, context = {}) {
  try {
    const action = String(args.action || '').trim();
    const by = String(context.clientName || context.chatId || '').slice(0, 64) || null;
    const loc = args.location || null;

    if (action === 'search') {
      const rows = await stockSearch(args.query || args.name || '', loc, 50);
      return { success: true, count: rows.length, items: rows.map(rowOut) };
    }

    if (action === 'list') {
      const rows = await stockList(loc, 50);
      return { success: true, count: rows.length, location: loc || 'все', items: rows.map(rowOut) };
    }

    if (action === 'add') {
      const name = String(args.name || '').trim();
      if (!name) return { success: false, message: 'Нужно name — наименование позиции.' };
      const exists = await stockGetByKey(loc || DEFAULT_LOCATION, normKey(name));
      if (exists) {
        return { success: false, reason: 'exists', item: rowOut(exists), message: 'Такая позиция уже есть — используй set (задать остаток) или adjust (приход/расход).' };
      }
      const r = await stockUpsertSet(loc || DEFAULT_LOCATION, name, Number(args.qty) || 0, args.unit, by);
      return { success: true, action: 'add', id: r.id, name, qty: r.qty, unit: args.unit || 'шт', location: loc || DEFAULT_LOCATION, note: `Добавлено: ${name} — ${fmtQty(r.qty)} ${args.unit || 'шт'}.` };
    }

    if (action === 'set') {
      if (args.qty == null) return { success: false, message: 'Нужно qty — остаток.' };
      const { rows } = await resolveTarget(args);
      if (rows.length > 1) return ambiguous(rows);
      // set создаёт позицию, если её не было (upsert) — но только когда задан name.
      if (rows.length === 0 && !args.name) return { success: false, reason: 'not_found', message: 'Позиция не найдена (укажи name или id).' };
      const target = rows[0];
      const r = await stockUpsertSet(
        (target && target.location) || loc || DEFAULT_LOCATION,
        target ? target.name : args.name,
        Number(args.qty),
        args.unit || (target && target.unit), by
      );
      const nm = target ? target.name : args.name;
      return { success: true, action: 'set', id: r.id, name: nm, qty: r.qty, created: !target, note: `${nm}: остаток установлен ${fmtQty(r.qty)}.` };
    }

    if (action === 'adjust') {
      if (args.delta == null) return { success: false, message: 'Нужно delta (приход +N / расход −N).' };
      const { rows } = await resolveTarget(args);
      if (rows.length === 0) return { success: false, reason: 'not_found', message: 'Позиция не найдена. Если новая — добавь через add.' };
      if (rows.length > 1) return ambiguous(rows);
      const target = rows[0];
      const res = await stockAdjust(target, Number(args.delta), by);
      return {
        success: true, action: 'adjust', id: target.id, name: target.name,
        old: res.old, qty: res.qty, delta: Number(args.delta), clamped: res.clamped,
        note: `${target.name}: ${fmtQty(res.old)} → ${fmtQty(res.qty)}`
          + (res.clamped ? ' (остаток не уходит ниже 0 — проверь число).' : '.'),
      };
    }

    if (action === 'remove') {
      const { rows } = await resolveTarget(args);
      if (rows.length === 0) return { success: false, reason: 'not_found', message: 'Позиция не найдена.' };
      if (rows.length > 1) return ambiguous(rows);
      const target = rows[0];
      const ok = await stockRemove(target.id);
      return { success: ok, action: 'remove', id: target.id, name: target.name, note: ok ? `Удалено: ${target.name}.` : 'Не удалось удалить.' };
    }

    if (action === 'rename') {
      const newName = String(args.new_name || '').trim();
      if (!newName) return { success: false, message: 'Нужно new_name.' };
      const { rows } = await resolveTarget(args);
      if (rows.length === 0) return { success: false, reason: 'not_found', message: 'Позиция не найдена.' };
      if (rows.length > 1) return ambiguous(rows);
      const target = rows[0];
      const ok = await stockRename(target.id, newName, by);
      return { success: ok, action: 'rename', id: target.id, old_name: target.name, name: newName };
    }

    return { success: false, message: `Неизвестное действие «${action}».` };
  } catch (err) {
    return handleToolDbError(err);
  }
}

module.exports = { definition, handler };

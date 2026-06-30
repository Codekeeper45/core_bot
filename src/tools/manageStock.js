'use strict';
// Учёт остатков склада. Доступен ВСЕМ (не в BOSS_ONLY): смотреть и менять остатки могут
// и босс, и сотрудники (без иерархии). Удаление — модель сначала подтверждает у человека.
const {
  stockSearch, stockList, stockGetById, stockGetByKey,
  stockUpsertSet, stockAdjust, stockMovement, stockReserve, stockReleaseReservation,
  stockListMovements, stockRemove, stockRename,
  stockLinkCatalog,
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
  const reserved = Number(r.reserved_qty || 0);
  const available = r.available_qty == null ? Number(r.qty) - reserved : Number(r.available_qty);
  return { id: r.id, name: r.name, qty: Number(r.qty), reserved, available, unit: r.unit, location: r.location };
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
      + 'Действия: search/list; receive — приход; issue — расход; reserve — резерв под объект; '
      + 'release/consume — снять или списать резерв; movements — история движений; adjust — совместимый приход(+)/расход(−); '
      + 'set — установить точный остаток; add — добавить новую позицию; remove — удалить позицию '
      + '(СНАЧАЛА подтверди у человека); rename — переименовать. Склад указывай в location '
      + '(Нижний/Покровка/Верхний); по умолчанию Нижний. Остаток бери ТОЛЬКО из ответа инструмента, '
      + 'не выдумывай. Если позиция найдена неоднозначно — уточни, не угадывай.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['search', 'list', 'receive', 'issue', 'reserve', 'release', 'consume', 'movements', 'link_catalog', 'adjust', 'set', 'add', 'remove', 'rename'], description: 'Что сделать.' },
        query: { type: 'string', description: 'search: что искать (бренд/ДН/Н/тип), напр. «аквасток дн200».' },
        name: { type: 'string', description: 'Наименование позиции (для set/adjust/add/remove/rename, если не задан id).' },
        id: { type: 'integer', description: 'id позиции (точная адресация для set/adjust/remove/rename).' },
        qty: { type: 'number', description: 'set/add: точный остаток.' },
        delta: { type: 'number', description: 'adjust: изменение остатка. Приход +N, расход −N.' },
        unit: { type: 'string', description: 'Единица (по умолчанию «шт»).' },
        location: { type: 'string', description: 'Склад: Нижний (умолч.) / Покровка / Верхний.' },
        new_name: { type: 'string', description: 'rename: новое наименование.' },
        reservation_id: { type: 'integer', description: 'ID резерва для release/consume.' },
        object_ref: { type: 'string', description: 'Объект/заказ, для которого выполняется движение или резерв.' },
        project_id: { type: 'integer' },
        task_id: { type: 'integer' },
        note: { type: 'string' },
        limit: { type: 'integer', description: 'Лимит истории движений.' },
        catalog_sku: { type: 'string', description: 'Точный артикул прайса для link_catalog.' },
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
      const addQty = Number(args.qty) || 0;
      if (addQty < 0) return { success: false, reason: 'invalid_qty', message: 'Остаток не может быть отрицательным.' };
      const r = await stockUpsertSet(loc || DEFAULT_LOCATION, name, addQty, args.unit, context);
      return { success: true, action: 'add', id: r.id, name, qty: r.qty, unit: args.unit || 'шт', location: loc || DEFAULT_LOCATION, note: `Добавлено: ${name} — ${fmtQty(r.qty)} ${args.unit || 'шт'}.` };
    }

    if (action === 'set') {
      if (args.qty == null) return { success: false, message: 'Нужно qty — остаток.' };
      const setQty = Number(args.qty);
      if (!Number.isFinite(setQty) || setQty < 0) return { success: false, reason: 'invalid_qty', message: 'Остаток не может быть отрицательным.' };
      const { rows } = await resolveTarget(args);
      if (rows.length > 1) return ambiguous(rows);
      // set создаёт позицию, если её не было (upsert) — но только когда задан name.
      if (rows.length === 0 && !args.name) return { success: false, reason: 'not_found', message: 'Позиция не найдена (укажи name или id).' };
      const target = rows[0];
      const r = await stockUpsertSet(
        (target && target.location) || loc || DEFAULT_LOCATION,
        target ? target.name : args.name,
        setQty,
        args.unit || (target && target.unit), context
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
      const res = await stockAdjust(target, Number(args.delta), context);
      if (!res.ok) {
        return { success: false, reason: res.reason, available: res.available, reserved: res.reserved,
          message: res.reason === 'insufficient_available' ? 'Недостаточно доступного остатка: часть товара зарезервирована или уже списана.' : 'Не удалось изменить остаток.' };
      }
      return {
        success: true, action: 'adjust', id: target.id, name: target.name,
        old: res.old, qty: res.qty, available: res.available, reserved: res.reserved,
        delta: Number(args.delta), note: `${target.name}: ${fmtQty(res.old)} → ${fmtQty(res.qty)}.`,
      };
    }

    if (action === 'receive' || action === 'issue' || action === 'reserve') {
      if (args.qty == null) return { success: false, reason: 'qty_required', message: 'Нужно qty.' };
      const { rows } = await resolveTarget(args);
      if (rows.length === 0) return { success: false, reason: 'not_found', message: 'Позиция не найдена.' };
      if (rows.length > 1) return ambiguous(rows);
      const target = rows[0];
      const meta = { ...context, object_ref: args.object_ref, project_id: args.project_id, task_id: args.task_id, note: args.note };
      const res = action === 'reserve'
        ? await stockReserve(target.id, Number(args.qty), meta)
        : await stockMovement(target.id, action, Number(args.qty), meta);
      if (!res.ok) return { success: false, action, id: target.id, name: target.name, ...res };
      return { success: true, action, id: target.id, name: target.name, ...res };
    }

    if (action === 'release' || action === 'consume') {
      if (!args.reservation_id) return { success: false, reason: 'reservation_id_required' };
      const res = await stockReleaseReservation(args.reservation_id, action === 'consume', { ...context, note: args.note });
      return { success: res.ok, action, ...res };
    }

    if (action === 'movements') {
      const { rows } = await resolveTarget(args);
      if (rows.length === 0) return { success: false, reason: 'not_found', message: 'Позиция не найдена.' };
      if (rows.length > 1) return ambiguous(rows);
      const movements = await stockListMovements(rows[0].id, args.limit);
      return { success: true, action, item: rowOut(rows[0]), count: movements.length, movements };
    }

    if (action === 'link_catalog') {
      if (!args.catalog_sku) return { success: false, reason: 'catalog_sku_required' };
      const { rows } = await resolveTarget(args);
      if (rows.length === 0) return { success: false, reason: 'not_found', message: 'Складская позиция не найдена.' };
      if (rows.length > 1) return ambiguous(rows);
      const linked = await stockLinkCatalog(rows[0].id, args.catalog_sku);
      return { success: linked.ok, action, ...linked };
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

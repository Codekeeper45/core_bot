'use strict';
// Ручное редактирование розничных прайсов (Аквасток + Gidrolica). Чтение и расчёт —
// отдельный инструмент price_catalog. Менять может любой (как склад, без иерархии).
// Каждое изменение пишется в журнал orch_price_changes (action=history).
const {
  priceGetBySku, priceSearch,
  priceSetPrice, priceSetDiscountPrice, priceAddItem, priceRemove, priceRename, priceListChanges,
} = require('../services/mysql');
const { handleToolDbError } = require('../utils/toolError');
const { displayArticle, supplierLabel } = require('../utils/priceDisplay');

function publicItem(item) {
  return {
    sku: displayArticle(item),
    source_sku: item.source_sku || null,
    supplier: item.supplier || null,
    supplier_label: supplierLabel(item.supplier),
    series: item.series_name || item.series || null,
    load_class: item.load_class || null,
    name: item.name,
    dn: item.dn || null,
    length_mm: item.length_mm == null ? null : Number(item.length_mm),
    width_mm: item.width_mm == null ? null : Number(item.width_mm),
    height_mm: item.height_mm == null ? null : Number(item.height_mm),
    weight_kg: item.weight_kg == null ? null : Number(item.weight_kg),
    pallet_qty: item.pallet_qty || null,
    retail_price: Number(item.retail_price),
    discount_price: item.discount_price == null ? null : Number(item.discount_price),
    dealer_price: item.dealer_price == null ? null : Number(item.dealer_price),
    dealer_price_2: item.dealer_price_2 == null ? null : Number(item.dealer_price_2),
    currency: item.currency || 'KZT',
  };
}

function ambiguous(rows) {
  return {
    success: false, reason: 'ambiguous',
    message: 'Несколько совпадений — уточни точный артикул (sku) или каталог (supplier: aquastok|gidrolica).',
    candidates: rows.map(publicItem),
  };
}

// Найти позицию для правки: по точному sku либо по поисковому запросу (query).
// Возвращает { rows } — пусто / одна / несколько (для ambiguous, в т.ч. когда
// один артикул есть в обоих каталогах).
async function resolveTarget(args, supplier) {
  if (args.sku) {
    return { rows: await priceGetBySku(args.sku, supplier) };
  }
  if (args.query) {
    return { rows: await priceSearch(args.query, 6, supplier) };
  }
  return { rows: [] };
}

const definition = {
  type: 'function',
  function: {
    name: 'manage_price',
    description:
      'Редактирование прайсов Аквасток / Norma (Январь 2026), Gidrolica (июль 2025) и Ballu ONEAIR (16.02.2026) — чтение/расчёт в price_catalog. Менять может любой. '
      + 'Действия: set_price — изменить розницу; set_discount_price — изменить цену со скидкой; add — добавить новую позицию (supplier ОБЯЗАТЕЛЕН); '
      + 'remove — удалить позицию (СНАЧАЛА подтверди у человека); rename — переименовать; '
      + 'history — журнал изменений цен. Позицию адресуй по точному артикулу (sku); если sku неизвестен, '
      + 'передай query — при нескольких совпадениях инструмент вернёт кандидатов (reason=ambiguous), не угадывай. '
      + 'Один артикул может быть в нескольких каталогах — тогда укажи supplier. Для КП основная цена — discount_price (у Gidrolica и Ballu её нет — розница/РРЦ).',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['set_price', 'set_discount_price', 'add', 'remove', 'rename', 'history'] },
        supplier: { type: 'string', enum: ['aquastok', 'gidrolica', 'ballu'], description: 'Каталог. Обязателен для add; для остальных — фильтр, нужен когда артикул есть в нескольких прайсах.' },
        sku: { type: 'string', description: 'Точный артикул позиции (для set_price/remove/rename/add).' },
        query: { type: 'string', description: 'Если sku неизвестен: название/DN/класс для поиска позиции (set_price/remove/rename).' },
        price: { type: 'number', description: 'Новая розничная цена (set_price/add).' },
        discount_price: { type: 'number', description: 'Цена со скидкой (set_discount_price/add).' },
        name: { type: 'string', description: 'Наименование (add) или новое имя (rename).' },
        series: { type: 'string', description: 'Серия (add).' },
        load_class: { type: 'string', description: 'Класс нагрузки (add).' },
        dn: { type: 'string', description: 'DN (add).' },
        length_mm: { type: 'number', description: 'Длина, мм (add).' },
        width_mm: { type: 'number', description: 'Ширина, мм (add).' },
        height_mm: { type: 'number', description: 'Высота, мм (add).' },
        weight_kg: { type: 'number', description: 'Вес, кг (add).' },
        pallet_qty: { type: 'string', description: 'Кол-во на поддоне (add, только Аквасток).' },
        currency: { type: 'string', description: 'Валюта, по умолчанию KZT (add).' },
        note: { type: 'string', description: 'Комментарий к изменению (опц.).' },
        limit: { type: 'integer', description: 'history: сколько записей (1–100, по умолч. 50).' },
      },
      required: ['action'],
    },
  },
};

async function handler(args, context = {}) {
  try {
    const action = args.action;
    const supplier = ['aquastok', 'gidrolica', 'ballu'].includes(args.supplier) ? args.supplier : null;

    if (action === 'history') {
      const rows = await priceListChanges(args.sku || null, args.limit, supplier);
      return { success: true, action, count: rows.length, changes: rows };
    }

    if (action === 'add') {
      const sku = String(args.sku || '').trim();
      const name = String(args.name || '').trim();
      if (!sku || !name) return { success: false, reason: 'sku_name_required', message: 'Для добавления нужны артикул (sku) и наименование (name).' };
      if (!supplier) return { success: false, reason: 'supplier_required', message: 'Укажи каталог (supplier): aquastok или gidrolica.' };
      if (args.price == null) return { success: false, reason: 'price_required', message: 'Нужна цена (price).' };
      const r = await priceAddItem({
        sku, name, supplier, retail_price: args.price,
        discount_price: args.discount_price,
        series: args.series, load_class: args.load_class, dn: args.dn,
        length_mm: args.length_mm, width_mm: args.width_mm, height_mm: args.height_mm,
        weight_kg: args.weight_kg, pallet_qty: args.pallet_qty,
        currency: args.currency,
      }, { ...context, note: args.note });
      if (!r.ok) {
        const msg = r.reason === 'exists' ? 'Такой артикул уже есть в этом каталоге — используй set_price.'
          : r.reason === 'invalid_price' ? 'Цена не может быть отрицательной.'
          : r.reason === 'invalid_discount_price' ? 'Цена со скидкой не может быть отрицательной.'
          : r.reason === 'supplier_required' ? 'Укажи каталог (supplier): aquastok или gidrolica.'
          : r.reason === 'no_active_catalog' ? 'Этот прайс ещё не импортирован — сначала загрузите файл.'
          : 'Не удалось добавить позицию.';
        return { success: false, reason: r.reason, message: msg };
      }
      return {
        success: true, action, sku: r.sku, supplier: r.supplier, supplier_label: supplierLabel(r.supplier),
        name: r.name, retail_price: r.retail_price,
        discount_price: r.discount_price, currency: r.currency,
        note: `Добавлено в ${supplierLabel(r.supplier)}: ${r.sku} «${r.name}» — розница ${r.retail_price}, скидочная ${r.discount_price ?? r.retail_price} ${r.currency}.`,
      };
    }

    // set_price / set_discount_price / remove / rename — нужна существующая позиция.
    const { rows } = await resolveTarget(args, supplier);
    if (rows.length === 0) return { success: false, reason: 'not_found', message: 'Позиция не найдена. Уточни артикул или добавь через add.' };
    if (rows.length > 1) return ambiguous(rows);
    const target = rows[0];

    if (action === 'set_price') {
      if (args.price == null) return { success: false, reason: 'price_required', message: 'Нужна цена (price).' };
      const r = await priceSetPrice(target.sku, args.price, { ...context, note: args.note }, target.supplier || null);
      if (!r.ok) return { success: false, reason: r.reason, message: r.reason === 'invalid_price' ? 'Цена не может быть отрицательной.' : 'Позиция не найдена.' };
      return { success: true, action, sku: r.sku, supplier: r.supplier, supplier_label: supplierLabel(r.supplier), name: r.name, old_price: r.old_price, new_price: r.new_price, currency: r.currency, note: `${supplierLabel(r.supplier)} — ${r.sku} «${r.name}»: ${r.old_price} → ${r.new_price} ${r.currency}.` };
    }

    if (action === 'set_discount_price') {
      if (args.discount_price == null && args.price == null) return { success: false, reason: 'discount_price_required', message: 'Нужна цена со скидкой (discount_price).' };
      const next = args.discount_price == null ? args.price : args.discount_price;
      const r = await priceSetDiscountPrice(target.sku, next, { ...context, note: args.note }, target.supplier || null);
      if (!r.ok) return { success: false, reason: r.reason, message: r.reason === 'invalid_price' ? 'Цена со скидкой не может быть отрицательной.' : 'Позиция не найдена.' };
      return {
        success: true,
        action,
        sku: r.sku,
        supplier: r.supplier,
        supplier_label: supplierLabel(r.supplier),
        name: r.name,
        old_discount_price: r.old_discount_price,
        new_discount_price: r.new_discount_price,
        currency: r.currency,
        note: `${supplierLabel(r.supplier)} — ${r.sku} «${r.name}»: скидочная ${r.old_discount_price ?? 'не была задана'} → ${r.new_discount_price} ${r.currency}.`,
      };
    }

    if (action === 'remove') {
      const r = await priceRemove(target.sku, { ...context, note: args.note }, target.supplier || null);
      if (!r.ok) return { success: false, reason: r.reason, message: 'Позиция не найдена.' };
      return { success: true, action, sku: r.sku, supplier: r.supplier, supplier_label: supplierLabel(r.supplier), name: r.name, note: `Удалено из прайса ${supplierLabel(r.supplier)}: ${r.sku} «${r.name}».` };
    }

    if (action === 'rename') {
      const newName = String(args.name || '').trim();
      if (!newName) return { success: false, reason: 'name_required', message: 'Нужно новое наименование (name).' };
      const r = await priceRename(target.sku, newName, { ...context, note: args.note }, target.supplier || null);
      if (!r.ok) return { success: false, reason: r.reason, message: 'Позиция не найдена.' };
      return { success: true, action, sku: r.sku, supplier: r.supplier, supplier_label: supplierLabel(r.supplier), old_name: r.old_name, new_name: r.new_name, note: `${supplierLabel(r.supplier)} — ${r.sku}: «${r.old_name}» → «${r.new_name}».` };
    }

    return { success: false, reason: 'invalid_action' };
  } catch (err) {
    return handleToolDbError(err);
  }
}

module.exports = { definition, handler };

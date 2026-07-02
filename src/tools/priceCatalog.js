'use strict';

const { priceGetBySku, priceSearch } = require('../services/mysql');
const { handleToolDbError } = require('../utils/toolError');
const { displayArticle, supplierLabel } = require('../utils/priceDisplay');

const definition = {
  type: 'function',
  function: {
    name: 'price_catalog',
    description: 'Ищет товары в двух прайсах — Аквасток / Norma (Январь 2026) и Gidrolica (июль 2025) — и рассчитывает стоимость по количеству. По умолчанию ищет в ОБОИХ; supplier сужает до одного. У Аквасток расчёт по "Цене со скидкой", у Gidrolica скидочной цены нет — считается по рознице. В ответе всегда называй каталог (supplier_label).',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['search', 'calculate'] },
        query: { type: 'string', description: 'Артикул, название, DN или класс нагрузки для search.' },
        supplier: { type: 'string', enum: ['aquastok', 'gidrolica'], description: 'Фильтр по каталогу (опционально). Нужен, когда артикул есть в обоих прайсах.' },
        price_basis: { type: 'string', enum: ['discount', 'retail'], description: 'calculate: discount (по умолчанию) или retail.' },
        lines: {
          type: 'array',
          description: 'Строки расчёта: точный артикул или однозначный поисковый запрос и количество.',
          items: {
            type: 'object',
            properties: {
              query: { type: 'string' },
              qty: { type: 'number' },
            },
            required: ['query', 'qty'],
          },
        },
      },
      required: ['action'],
    },
  },
};

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
    effective_price: item.discount_price == null ? Number(item.retail_price) : Number(item.discount_price),
    price_basis: item.discount_price == null ? 'retail' : 'discount',
    currency: item.currency || 'KZT',
    source_file: item.source_file || null,
    price_date: item.price_date || null,
  };
}

async function resolveLine(query, supplier = null) {
  const raw = String(query || '').trim();
  if (!raw) return { reason: 'invalid_query', candidates: [] };
  const exact = await priceGetBySku(raw, supplier);
  if (exact.length === 1) return { item: exact[0] };
  if (exact.length > 1) {
    // Один артикул в обоих каталогах (например «1101») — пусть человек уточнит.
    return { reason: 'ambiguous', candidates: exact.map(publicItem) };
  }
  const matches = await priceSearch(raw, 6, supplier);
  if (matches.length === 1) return { item: matches[0] };
  return { reason: matches.length ? 'ambiguous' : 'not_found', candidates: matches.map(publicItem) };
}

function suppliersNote(suppliers) {
  const labels = [...suppliers].map(supplierLabel).filter(Boolean);
  return labels.length ? labels.join(' и ') : 'активных прайсов';
}

async function handler(args) {
  try {
    const supplier = args.supplier === 'aquastok' || args.supplier === 'gidrolica' ? args.supplier : null;
    if (args.action === 'search') {
      const rows = await priceSearch(args.query || '', 20, supplier);
      return {
        success: true,
        count: rows.length,
        items: rows.map(publicItem),
        note: 'Поиск по прайсам Аквасток/Norma (янв 2026) и Gidrolica (июль 2025); у каждой позиции есть supplier_label — называй каталог в ответе. Для расчётов у Аквасток по умолчанию "Цена со скидкой", у Gidrolica — розница.',
      };
    }
    if (args.action !== 'calculate') return { success: false, reason: 'invalid_action' };
    const input = Array.isArray(args.lines) ? args.lines : [];
    if (!input.length) return { success: false, reason: 'empty_lines', message: 'Добавь хотя бы одну позицию.' };
    const basis = args.price_basis === 'retail' ? 'retail' : 'discount';
    const lines = [];
    for (const line of input) {
      const qty = Number(line.qty);
      if (!Number.isFinite(qty) || qty <= 0) {
        return { success: false, reason: 'invalid_qty', query: line.query, message: 'Количество должно быть больше нуля.' };
      }
      const resolved = await resolveLine(line.query, supplier);
      if (!resolved.item) {
        return { success: false, reason: resolved.reason, query: line.query, candidates: resolved.candidates };
      }
      const item = publicItem(resolved.item);
      const unitPrice = basis === 'retail' ? item.retail_price : item.effective_price;
      lines.push({
        ...item,
        qty,
        unit_price: unitPrice,
        line_total: Number((unitPrice * qty).toFixed(2)),
      });
    }
    const usedSuppliers = new Set(lines.map((l) => l.supplier).filter(Boolean));
    const mixed = usedSuppliers.size > 1;
    return {
      success: true,
      lines,
      total: Number(lines.reduce((sum, line) => sum + line.line_total, 0).toFixed(2)),
      currency: 'KZT',
      price_basis: basis,
      mixed_suppliers: mixed,
      note: (basis === 'discount'
        ? `Расчёт по "Цене со скидкой" (у Gidrolica её нет — такие строки по рознице, см. price_basis строки). Каталоги: ${suppliersNote(usedSuppliers)}.`
        : `Расчёт по колонке "Розница". Каталоги: ${suppliersNote(usedSuppliers)}.`)
        + (mixed ? ' ВНИМАНИЕ: в расчёте позиции РАЗНЫХ поставщиков — обязательно скажи об этом человеку.' : ''),
    };
  } catch (err) {
    return handleToolDbError(err);
  }
}

module.exports = { definition, handler };

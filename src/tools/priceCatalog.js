'use strict';

const { priceGetBySku, priceSearch } = require('../services/mysql');
const { handleToolDbError } = require('../utils/toolError');

const definition = {
  type: 'function',
  function: {
    name: 'price_catalog',
    description: 'Ищет товары в прайсе Аквасток / Norma Январь 2026 и рассчитывает стоимость по количеству. По умолчанию считает по колонке "Цена со скидкой"; розницу показывает справочно.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['search', 'calculate'] },
        query: { type: 'string', description: 'Артикул, название, DN или класс нагрузки для search.' },
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
    sku: item.sku,
    source_sku: item.source_sku || null,
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
    price_date: item.price_date || '2026-01-01',
  };
}

async function resolveLine(query) {
  const raw = String(query || '').trim();
  if (!raw) return { reason: 'invalid_query', candidates: [] };
  const exact = await priceGetBySku(raw);
  if (exact) return { item: exact };
  const matches = await priceSearch(raw, 6);
  if (matches.length === 1) return { item: matches[0] };
  return { reason: matches.length ? 'ambiguous' : 'not_found', candidates: matches.map(publicItem) };
}

async function handler(args) {
  try {
    if (args.action === 'search') {
      const rows = await priceSearch(args.query || '', 20);
      return {
        success: true,
        count: rows.length,
        items: rows.map(publicItem),
        note: 'Прайс Аквасток / Norma Январь 2026. Для расчётов по умолчанию используй "Цена со скидкой"; розница справочно.',
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
      const resolved = await resolveLine(line.query);
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
    return {
      success: true,
      lines,
      total: Number(lines.reduce((sum, line) => sum + line.line_total, 0).toFixed(2)),
      currency: 'KZT',
      price_basis: basis,
      note: basis === 'discount'
        ? 'Расчёт по колонке "Цена со скидкой" прайса Аквасток / Norma Январь 2026; розница справочно.'
        : 'Расчёт по колонке "Розница" прайса Аквасток / Norma Январь 2026; скидочная цена справочно.',
    };
  } catch (err) {
    return handleToolDbError(err);
  }
}

module.exports = { definition, handler };

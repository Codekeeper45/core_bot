'use strict';

const config = require('../config');
const { priceGetBySku, priceSearch } = require('../services/mysql');
const notifier = require('../services/notifier');
const { renderQuote, MAX_LINES, TERMS_SLOTS } = require('../services/quoteWorkbook');
const { displayArticle, supplierLabel } = require('../utils/priceDisplay');
const { handleToolDbError } = require('../utils/toolError');

const SUPPLIERS = new Set(['aquastok', 'gidrolica', 'ballu']);
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

const definition = {
  type: 'function',
  function: {
    name: 'generate_quote',
    description:
      'Создать и отправить в текущий чат Excel-коммерческое предложение по шаблону Neodrain. '
      + 'До вызова ОБЯЗАТЕЛЬНО уточни у человека номер КП, получателя, условия и позиции с количеством. '
      + 'Цены и характеристики берутся только из активных прайсов. В КП ВСЕГДА используй розничную '
      + 'цену/РРЦ, включая Аквасток/Norma. При нескольких поставщиках сначала явно предупреди; '
      + 'allow_mixed_suppliers=true передавай только после подтверждения человека.',
    parameters: {
      type: 'object',
      properties: {
        quote_number: { type: 'string', description: 'Номер исходящего КП, например 3-2206.' },
        recipient: { type: 'string', description: 'Получатель/компания, кому адресовано КП.' },
        offer_date: { type: 'string', description: 'Дата КП в формате YYYY-MM-DD. По умолчанию сегодня (Казахстан).' },
        terms: {
          type: 'array',
          description: `Условия конкретного КП: от 1 до ${TERMS_SLOTS} коротких строк. Не копируй старые условия Gidrolica/НДС из образца.`,
          items: { type: 'string' },
        },
        lines: {
          type: 'array',
          description: `Позиции КП, от 1 до ${MAX_LINES}.`,
          items: {
            type: 'object',
            properties: {
              query: { type: 'string', description: 'Точный артикул или однозначный запрос.' },
              qty: { type: 'number', description: 'Количество, больше нуля.' },
              supplier: { type: 'string', enum: ['aquastok', 'gidrolica', 'ballu'], description: 'Каталог, если артикул есть у нескольких поставщиков.' },
            },
            required: ['query', 'qty'],
          },
        },
        allow_mixed_suppliers: { type: 'boolean', description: 'true только после явного подтверждения человека на одно КП из разных прайсов.' },
      },
      required: ['quote_number', 'recipient', 'terms', 'lines'],
    },
  },
};

function localToday() {
  const local = new Date(Date.now() + config.SCHEDULER_TZ_OFFSET_MIN * 60000);
  return local.toISOString().slice(0, 10);
}

function formatOfferDate(value) {
  const raw = String(value || localToday()).trim();
  const match = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  return `${match[3]}.${match[2]}.${match[1]}`;
}

function publicCandidate(item) {
  return {
    sku: displayArticle(item),
    supplier: item.supplier,
    supplier_label: supplierLabel(item.supplier),
    name: item.name,
    dn: item.dn || null,
    load_class: item.load_class || null,
    retail_price: Number(item.retail_price),
    discount_price: item.discount_price == null ? null : Number(item.discount_price),
  };
}

async function resolveLine(query, supplier) {
  const exact = await priceGetBySku(query, supplier || null);
  if (exact.length === 1) return { item: exact[0] };
  if (exact.length > 1) return { reason: 'ambiguous', candidates: exact.map(publicCandidate) };
  const matches = await priceSearch(query, 8, supplier || null);
  if (matches.length === 1) return { item: matches[0] };
  return { reason: matches.length ? 'ambiguous' : 'not_found', candidates: matches.map(publicCandidate) };
}

function quotePrice(item) {
  return { unit_price: Number(item.retail_price), price_basis: 'retail' };
}

function normalizeTerms(raw) {
  const values = Array.isArray(raw) ? raw : [raw];
  const terms = values.map((value) => String(value || '').trim()).filter(Boolean);
  return terms.length >= 1 && terms.length <= TERMS_SLOTS ? terms : null;
}

function fileName(quoteNumber) {
  const safe = String(quoteNumber).trim().replace(/[\\/:*?"<>|]+/g, '-').slice(0, 80) || 'без-номера';
  return `КП Неодрейн ${safe}.xlsx`;
}

async function handler(args = {}, context = {}) {
  try {
    if (context.channel === 'instagram') {
      return { success: false, reason: 'channel_unsupported', message: 'В Instagram нельзя отправить Excel-файл. Открой этот чат в WhatsApp или Telegram.' };
    }
    const quoteNumber = String(args.quote_number || '').trim();
    const recipient = String(args.recipient || '').trim();
    const offerDate = formatOfferDate(args.offer_date);
    const terms = normalizeTerms(args.terms);
    const input = Array.isArray(args.lines) ? args.lines : [];
    if (!quoteNumber) return { success: false, reason: 'quote_number_required', message: 'Нужен номер КП.' };
    if (!recipient) return { success: false, reason: 'recipient_required', message: 'Нужен получатель КП.' };
    if (!offerDate) return { success: false, reason: 'invalid_offer_date', message: 'Дата КП нужна в формате YYYY-MM-DD.' };
    if (!terms) return { success: false, reason: 'terms_required', message: `Нужны условия КП: от 1 до ${TERMS_SLOTS} непустых строк.` };
    if (input.length < 1 || input.length > MAX_LINES) {
      return { success: false, reason: 'invalid_line_count', message: `В КП нужно от 1 до ${MAX_LINES} позиций.` };
    }

    const lines = [];
    for (const inputLine of input) {
      const query = String(inputLine && inputLine.query || '').trim();
      const qty = Number(inputLine && inputLine.qty);
      const supplier = inputLine && inputLine.supplier ? String(inputLine.supplier) : null;
      if (!query) return { success: false, reason: 'query_required', message: 'У каждой позиции нужен артикул или запрос.' };
      if (supplier && !SUPPLIERS.has(supplier)) return { success: false, reason: 'invalid_supplier', query, message: 'Неизвестный каталог позиции.' };
      if (!Number.isFinite(qty) || qty <= 0) return { success: false, reason: 'invalid_qty', query, message: 'Количество должно быть больше нуля.' };
      const resolved = await resolveLine(query, supplier);
      if (!resolved.item) return { success: false, reason: resolved.reason, query, candidates: resolved.candidates || [] };
      const item = resolved.item;
      const price = quotePrice(item);
      lines.push({
        sku: displayArticle(item),
        supplier: item.supplier,
        supplier_label: supplierLabel(item.supplier),
        name: item.name,
        length_mm: item.length_mm == null ? null : Number(item.length_mm),
        width_mm: item.width_mm == null ? null : Number(item.width_mm),
        dn: item.dn || null,
        height_mm: item.height_mm == null ? null : Number(item.height_mm),
        qty,
        unit_price: price.unit_price,
        price_basis: price.price_basis,
        line_total: Number((price.unit_price * qty).toFixed(2)),
      });
    }

    const suppliers = [...new Set(lines.map((line) => line.supplier).filter(Boolean))];
    if (suppliers.length > 1 && args.allow_mixed_suppliers !== true) {
      return {
        success: false,
        reason: 'mixed_suppliers_confirmation_required',
        suppliers: suppliers.map((supplier) => ({ supplier, supplier_label: supplierLabel(supplier) })),
        message: 'В КП позиции из разных прайсов. Подтверди у человека смешение поставщиков, затем повтори с allow_mixed_suppliers=true.',
      };
    }

    const total = Number(lines.reduce((sum, line) => sum + line.line_total, 0).toFixed(2));
    const buffer = await renderQuote({ quote_number: quoteNumber, recipient, offer_date: offerDate, terms, lines, total });
    const name = fileName(quoteNumber);
    const sent = await notifier.deliver(context.channel, context.chatId, '', {
      kind: 'document', buffer, fileName: name, mimetype: XLSX_MIME,
    }, { record: true });
    if (!sent) return { success: false, reason: 'delivery_failed', message: 'КП сформировано, но не удалось отправить файл в этот чат.' };
    return {
      success: true,
      file_name: name,
      total,
      currency: 'KZT',
      suppliers: suppliers.map((supplier) => ({ supplier, supplier_label: supplierLabel(supplier) })),
      lines: lines.map((line) => ({ sku: line.sku, name: line.name, qty: line.qty, unit_price: line.unit_price, line_total: line.line_total, price_basis: line.price_basis })),
      note: 'КП отправлено Excel-файлом.',
    };
  } catch (err) {
    if (String(err && err.message) === 'quote_template_missing') {
      return { success: false, reason: 'template_missing', message: 'Шаблон КП не найден на сервере. Сообщи разработчику.' };
    }
    if (String(err && err.message).startsWith('quote_')) {
      return { success: false, reason: 'template_error', message: 'Не удалось сформировать КП по шаблону. Сообщи разработчику.' };
    }
    return handleToolDbError(err);
  }
}

module.exports = { definition, handler, _internals: { formatOfferDate, normalizeTerms, quotePrice, fileName } };

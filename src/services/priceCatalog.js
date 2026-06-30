'use strict';

const fs = require('fs');
const crypto = require('crypto');
const XLSX = require('xlsx');
const { normKey } = require('../utils/stockKey');

const AQUASTOK_SHEET = 'Norma с ТТ';
const AQUASTOK_PRICE_DATE = '2026-01-01';

function numeric(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const raw = String(value == null ? '' : value).trim().replace(/\s+/g, '');
  if (!raw) return null;
  // В казахстанском прайсе запятая разделяет тысячи: "6,600" = 6600.
  const normalized = /^-?\d{1,3}(,\d{3})+$/.test(raw)
    ? raw.replace(/,/g, '')
    : raw.replace(',', '.');
  const n = Number(normalized);
  return Number.isFinite(n) ? n : null;
}

function clean(value) { return String(value == null ? '' : value).replace(/\s+/g, ' ').trim(); }

function normalizeHeader(value) {
  return clean(value)
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/\s+/g, ' ')
    .trim();
}

function headerMap(row) {
  const map = new Map();
  for (let i = 0; i < row.length; i++) {
    const key = normalizeHeader(row[i]);
    if (key) map.set(key, i);
  }
  return map;
}

function col(map, name) {
  const idx = map.get(normalizeHeader(name));
  if (idx == null) throw new Error(`price_workbook_missing_column:${name}`);
  return idx;
}

function syntheticSku(rawSku, rowNumber) {
  const sku = clean(rawSku);
  // Пустой артикул — позиция без артикула; синтетический ключ для уникальности,
  // наружу артикул показывается как «нет» (source_sku остаётся null).
  if (!sku) return `AQ-NOART-R${String(rowNumber).padStart(3, '0')}`;
  if (sku.toLowerCase() !== 'новинка') return sku;
  return `AQ-NOVINKA-R${String(rowNumber).padStart(3, '0')}`;
}

function parsePriceWorkbook(filePath) {
  const buffer = fs.readFileSync(filePath);
  const workbook = XLSX.read(buffer, { type: 'buffer', cellDates: false });
  const sheet = workbook.SheetNames.includes(AQUASTOK_SHEET) ? AQUASTOK_SHEET : workbook.SheetNames[0];
  if (!sheet) throw new Error('price_workbook_has_no_sheets');
  const rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheet], { header: 1, defval: '', raw: true });
  if (sheet !== AQUASTOK_SHEET) throw new Error(`price_workbook_missing_sheet:${AQUASTOK_SHEET}`);
  if (!rows.length) throw new Error('price_workbook_has_no_rows');

  const headers = headerMap(rows[0] || []);
  const indexes = {
    sku: col(headers, 'Артикул'),
    name: col(headers, 'Типоразмер'),
    dn: col(headers, 'DN'),
    loadClass: col(headers, 'Класс нагрузки'),
    length: col(headers, 'Длина, мм'),
    width: col(headers, 'Ширина, мм'),
    height: col(headers, 'Высота, мм'),
    weight: col(headers, 'Вес, кг'),
    palletQty: col(headers, 'Кол-во на поддоне'),
    retailPrice: col(headers, 'Розница, тг'),
    discountPrice: col(headers, 'Цена со скидкой'),
  };

  const items = [];
  let currentSection = null;
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i] || [];
    const rowNumber = i + 1;
    const rawSku = clean(row[indexes.sku]);
    const name = clean(row[indexes.name]);
    if (rawSku && !name) {
      currentSection = rawSku;
      continue;
    }
    const sku = syntheticSku(rawSku, rowNumber);
    const price = numeric(row[indexes.retailPrice]);
    const discountPrice = numeric(row[indexes.discountPrice]);
    // Импортируем и позиции без артикула (sku синтетический), важно лишь наличие
    // наименования и розничной цены (колонка retail_price NOT NULL).
    if (!name || price == null) continue;
    const item = {
      row_number: rowNumber,
      series: currentSection,
      sku,
      source_sku: rawSku.toLowerCase() === 'новинка' ? rawSku : null,
      load_class: clean(row[indexes.loadClass]) || null,
      name,
      dn: clean(row[indexes.dn]) || null,
      length_mm: numeric(row[indexes.length]),
      width_mm: numeric(row[indexes.width]),
      height_mm: numeric(row[indexes.height]),
      weight_kg: numeric(row[indexes.weight]),
      pallet_qty: clean(row[indexes.palletQty]) || null,
      retail_price: price,
      discount_price: discountPrice,
      currency: 'KZT',
    };
    item.norm_key = normKey([item.sku, item.source_sku, item.series, item.load_class, item.name, item.dn, item.pallet_qty].filter(Boolean).join(' '));
    items.push(item);
  }
  const unique = new Set(items.map((x) => x.sku));
  if (unique.size !== items.length) throw new Error('price_workbook_has_duplicate_sku');
  return {
    source_file: filePath.split(/[\\/]/).pop(),
    source_hash: crypto.createHash('sha256').update(buffer).digest('hex'),
    sheet,
    price_date: AQUASTOK_PRICE_DATE,
    items,
  };
}

async function importPriceWorkbook(filePath, opts = {}) {
  const parsed = parsePriceWorkbook(filePath);
  const mysql = require('./mysql');
  return mysql.importPriceCatalog(parsed, opts);
}

module.exports = { numeric, parsePriceWorkbook, importPriceWorkbook };

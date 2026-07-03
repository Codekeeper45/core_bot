'use strict';

const fs = require('fs');
const crypto = require('crypto');
const XLSX = require('xlsx');
const { normKey } = require('../utils/stockKey');

// Поставщики живут в БД одновременно: у каждого свой лист, свой формат
// колонок и свой префикс синтетических артикулов. active-флаг снимка скоупится
// по supplier (см. mysql.importPriceCatalog).
const SUPPLIERS = {
  aquastok: {
    sheet: 'Norma с ТТ',
    price_date: '2026-01-01',
    synthetic_prefix: 'AQ',
    parseRows: parseAquastokRows,
  },
  gidrolica: {
    sheet: 'Пластик ТДЕ',
    price_date: '2025-07-01',
    synthetic_prefix: 'GD',
    parseRows: parseGidrolicaRows,
  },
  ballu: {
    sheet: 'ONEAIR',
    price_date: '2026-02-16',
    synthetic_prefix: 'BL',
    parseRows: parseBalluRows,
  },
};

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

function syntheticSku(rawSku, rowNumber, prefix) {
  const sku = clean(rawSku);
  // Пустой артикул — позиция без артикула; синтетический ключ для уникальности,
  // наружу артикул показывается как «нет» (source_sku остаётся null).
  if (!sku) return `${prefix}-NOART-R${String(rowNumber).padStart(3, '0')}`;
  if (sku.toLowerCase() !== 'новинка') return sku;
  return `${prefix}-NOVINKA-R${String(rowNumber).padStart(3, '0')}`;
}

function parseAquastokRows(rows) {
  const prefix = SUPPLIERS.aquastok.synthetic_prefix;
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
    const sku = syntheticSku(rawSku, rowNumber, prefix);
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
  return items;
}

// Прайс Gidrolica: заголовок — строка с «№ по каталогу» в колонке 1 (строка 0 —
// объединённый титул). Колонки фиксированы относительно якоря: 0=серия, 1=артикул,
// 2=класс нагрузки, 3=наименование, 4=DN (или «шт.»), 5-8 габариты/вес, 9=розница.
// Секции (строки без артикула с текстом в кол.0) дают контекст: DN для
// принадлежностей и типы («пескоуловители», «дождеприемники») в norm_key.
function parseGidrolicaRows(rows) {
  const prefix = SUPPLIERS.gidrolica.synthetic_prefix;
  let headerIdx = -1;
  for (let i = 0; i < rows.length; i++) {
    if (normalizeHeader((rows[i] || [])[1]) === normalizeHeader('№ по каталогу')) { headerIdx = i; break; }
  }
  if (headerIdx < 0) throw new Error('price_workbook_missing_column:№ по каталогу');

  const items = [];
  let currentSection = null;
  for (let i = headerIdx + 1; i < rows.length; i++) {
    const row = rows[i] || [];
    const rowNumber = i + 1;
    const rawSku = clean(row[1]);
    const name = clean(row[3]);
    if (!rawSku && clean(row[0])) {
      currentSection = clean(row[0]);
      continue;
    }
    const price = numeric(row[9]);
    // Позиция = наименование + положительная розница (строка 15 «…| 0» отсеивается).
    if (!name || price == null || price <= 0) continue;
    const sku = syntheticSku(rawSku, rowNumber, prefix);
    const rawDn = clean(row[4]);
    let dn = null;
    if (/^dn/i.test(rawDn)) dn = rawDn.replace(/\s+/g, '');
    else if (currentSection) dn = (currentSection.match(/DN\d+(?:\/\d+)?/i) || [null])[0];
    const loadClass = clean(row[2]);
    const item = {
      row_number: rowNumber,
      series: clean(row[0]) || null,
      sku,
      source_sku: null,
      load_class: loadClass && loadClass !== '-' ? loadClass : null,
      name,
      dn,
      length_mm: numeric(row[5]),
      width_mm: numeric(row[6]),
      height_mm: numeric(row[7]),
      weight_kg: numeric(row[8]),
      pallet_qty: null,
      retail_price: price,
      discount_price: null,
      currency: 'KZT',
    };
    item.norm_key = normKey([item.sku, item.series, currentSection, item.load_class, item.name, item.dn].filter(Boolean).join(' '));
    items.push(item);
  }
  return items;
}

// Прайс Ballu ONEAIR (очистители воздуха): лист «ONEAIR». Секции — повторяющиеся
// строки-заголовки с «НС-код» в кол.1 и названием серии в кол.2 (ASP-200Х и т.п.).
// Колонки позиции: 1=НС-код, 2=наименование, 3=примечание (наличие/для какой
// модели), 5=РРЦ (розница; НАША база расчёта), 9=дилерская Д (квартал <800 тыс),
// 12=дилерская Д1 (квартал ≥800 тыс). Дилерские цены — ЗАКУПОЧНЫЕ: хранятся в
// dealer_price/dealer_price_2 справочно, discount_price НЕ заполняем, чтобы
// расчёт КП по умолчанию шёл по РРЦ, а не по закупке. Лист «Конкуренты» игнорируем.
function parseBalluRows(rows) {
  const prefix = SUPPLIERS.ballu.synthetic_prefix;
  const items = [];
  let currentSection = null;
  let seenHeader = false;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i] || [];
    const rowNumber = i + 1;
    const rawSku = clean(row[1]);
    if (rawSku === 'НС-код') {
      currentSection = clean(row[2]) || currentSection;
      seenHeader = true;
      continue;
    }
    if (!seenHeader) continue; // шапка таблицы до первой секции
    const name = clean(row[2]);
    const price = numeric(row[5]);
    if (!rawSku || !name || price == null || price <= 0) continue;
    const note = clean(row[3]);
    const item = {
      row_number: rowNumber,
      series: currentSection,
      sku: syntheticSku(rawSku, rowNumber, prefix),
      source_sku: null,
      load_class: null,
      name,
      dn: null,
      length_mm: null,
      width_mm: null,
      height_mm: null,
      weight_kg: null,
      pallet_qty: null,
      retail_price: price,
      discount_price: null,
      dealer_price: numeric(row[9]),
      dealer_price_2: numeric(row[12]),
      currency: 'KZT',
    };
    item.norm_key = normKey([item.sku, item.series, item.name, note].filter(Boolean).join(' '));
    items.push(item);
  }
  return items;
}

function detectSupplier(workbook) {
  for (const [id, cfg] of Object.entries(SUPPLIERS)) {
    if (workbook.SheetNames.includes(cfg.sheet)) return id;
  }
  return null;
}

function parsePriceWorkbook(filePath, supplier = 'aquastok') {
  const cfg = SUPPLIERS[supplier];
  if (!cfg) throw new Error(`price_workbook_unknown_supplier:${supplier}`);
  const buffer = fs.readFileSync(filePath);
  const workbook = XLSX.read(buffer, { type: 'buffer', cellDates: false });
  if (!workbook.SheetNames.length) throw new Error('price_workbook_has_no_sheets');
  if (!workbook.SheetNames.includes(cfg.sheet)) throw new Error(`price_workbook_missing_sheet:${cfg.sheet}`);
  const rows = XLSX.utils.sheet_to_json(workbook.Sheets[cfg.sheet], { header: 1, defval: '', raw: true });
  if (!rows.length) throw new Error('price_workbook_has_no_rows');

  const items = cfg.parseRows(rows);
  const unique = new Set(items.map((x) => x.sku));
  if (unique.size !== items.length) throw new Error('price_workbook_has_duplicate_sku');
  return {
    supplier,
    source_file: filePath.split(/[\\/]/).pop(),
    source_hash: crypto.createHash('sha256').update(buffer).digest('hex'),
    sheet: cfg.sheet,
    price_date: cfg.price_date,
    items,
  };
}

async function importPriceWorkbook(filePath, opts = {}) {
  let supplier = opts.supplier || null;
  if (!supplier) {
    const buffer = fs.readFileSync(filePath);
    const workbook = XLSX.read(buffer, { type: 'buffer', cellDates: false, bookSheets: true });
    supplier = detectSupplier(workbook);
  }
  if (!supplier) throw new Error('price_workbook_unknown_supplier');
  const parsed = parsePriceWorkbook(filePath, supplier);
  const mysql = require('./mysql');
  return mysql.importPriceCatalog(parsed, opts);
}

module.exports = { numeric, parsePriceWorkbook, importPriceWorkbook, detectSupplier, SUPPLIERS };

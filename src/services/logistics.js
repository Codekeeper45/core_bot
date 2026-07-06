'use strict';

// Парсер логистической/паллетировочной базы из трёх файлов в корне репозитория.
// Это ОТДЕЛЬНАЯ справочная информация (вес, объём, кол-во на паллете, справочник
// машин) — она НЕ связана с прайсами/каталогами. У каждого листа своя раскладка
// колонок, поэтому источники описаны картой колонок (SOURCES / TRUCK_SOURCE).
//
// Строки тегируются источником (source), дубли одного артикула из разных файлов
// сохраняются намеренно — «залить всю информацию». Дедуп по приоритету источника
// делается при чтении (mysql.logisticsGetByArticle), не при парсинге.

const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');
const { normKey } = require('../utils/stockKey');

// ── Утилиты ─────────────────────────────────────────────────────────────────

function clean(value) { return String(value == null ? '' : value).replace(/\s+/g, ' ').trim(); }

function numeric(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const raw = String(value == null ? '' : value).trim().replace(/\s+/g, '');
  if (!raw) return null;
  const n = Number(raw.replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

function intOrNull(value) {
  const n = numeric(value);
  return n == null ? null : Math.round(n);
}

// Габариты одной строкой: "1000 х 148 х 55" → { length, width, height }.
function parseDimsString(value) {
  const parts = String(value == null ? '' : value)
    .split(/[хx*×]/i)
    .map((p) => numeric(p))
    .filter((n) => n != null);
  return {
    length_mm: parts[0] ?? null,
    width_mm: parts[1] ?? null,
    height_mm: parts[2] ?? null,
  };
}

// DN из наименования, когда отдельной колонки нет: "…Norma DN100 H55" → "DN100".
function dnFromName(name) {
  const m = String(name || '').match(/DN\s*\d+(?:\/\d+)?/i);
  return m ? m[0].replace(/\s+/g, '').toUpperCase() : null;
}

// Объём 1 ед.: из файла, иначе из габаритов (мм³ → м³), иначе null.
function resolveVolume(explicit, dims) {
  const v = numeric(explicit);
  if (v != null && v > 0) return v;
  if (dims.length_mm && dims.width_mm && dims.height_mm) {
    return Number(((dims.length_mm * dims.width_mm * dims.height_mm) / 1e9).toFixed(5));
  }
  return null;
}

// ── Карта источников (индексы колонок выверены чтением файлов) ────────────────
// dims: 'split' — габариты одной строкой в колонке dimsCol; иначе колонки l/w/h.

const SOURCES = [
  {
    source: 'ves_plastik',
    filePattern: /вес.*паллет.*пластик.*\.xlsx$/iu,
    sheet: 'Лист1',
    dataStart: 1,
    col: { article: 0, name: 1, load_class: 3, dimsCol: 4, weight: 5, qty_per_pallet: 6 },
    dims: 'split',
  },
  {
    source: 'raspal_tde',
    filePattern: /распал.*\.xlsx$/iu,
    sheet: 'ТДЕ',
    dataStart: 4,
    col: { article: 1, load_class: 2, name: 3, dn: 4, l: 5, w: 6, h: 7, volume: 8, weight: 9, note: 10, qty_per_pallet: 11 },
  },
  {
    source: 'raspal_beton',
    filePattern: /распал.*\.xlsx$/iu,
    sheet: ' Бетон БГ',
    dataStart: 3,
    col: { series: 0, article: 1, load_class: 2, name: 3, dn: 4, l: 5, w: 6, h: 7, weight: 8, volume: 9, note: 10, qty_per_pallet: 11 },
  },
  {
    source: 'raspal_yartsevo',
    filePattern: /распал.*\.xlsx$/iu,
    sheet: ' Ярцево Beton',
    dataStart: 3,
    col: { article: 1, load_class: 2, name: 3, dn: 4, l: 5, w: 6, h: 7, weight: 8, qty_per_pallet: 9 },
  },
  {
    source: 'palletirovka',
    filePattern: /паллетировка.*\.ods$/iu,
    sheet: 'Sheet1',
    dataStart: 5,
    col: { series: 0, article: 1, name: 2, dn: 3, load_class: 4, l: 5, w: 6, h: 7, volume: 8, weight: 12, qty_per_pallet: 13, pallet_weight: 14 },
  },
];

// Справочник машин живёт в «Распаллетке», лист «РАЗМЕЩЕНИЕ ПАЛЕТ».
const TRUCK_SOURCE = {
  filePattern: /распал.*\.xlsx$/iu,
  sheet: 'РАЗМЕЩЕНИЕ ПАЛЕТ',
  dataStart: 1,
  col: { name: 0, payload_t: 1, volume_m3: 2, inner_height_m: 3, inner_width_m: 4, inner_length_m: 5, pallet_places: 6 },
};

// ── Парсинг одного источника-листа ────────────────────────────────────────────

function sheetRows(workbook, sheetName) {
  const ws = workbook.Sheets[sheetName];
  if (!ws) return null;
  return XLSX.utils.sheet_to_json(ws, { header: 1, blankrows: false, defval: null });
}

function parseItemsFromSheet(rows, cfg) {
  const items = [];
  const c = cfg.col;
  for (let i = cfg.dataStart; i < rows.length; i++) {
    const row = rows[i] || [];
    const article = clean(row[c.article]);
    const name = clean(row[c.name]);
    const weight = numeric(row[c.weight]);
    // Guard: настоящая позиция — есть артикул, имя и положительный вес.
    // Строки-секции (артикул пуст) и заголовки этим отсекаются.
    if (!article || !name || !(weight != null && weight > 0)) continue;

    const dims = cfg.dims === 'split'
      ? parseDimsString(row[c.dimsCol])
      : { length_mm: numeric(row[c.l]), width_mm: numeric(row[c.w]), height_mm: numeric(row[c.h]) };

    const series = c.series != null ? (clean(row[c.series]) || null) : null;
    const dn = c.dn != null ? (clean(row[c.dn]) || null) : dnFromName(name);
    const load_class = c.load_class != null ? (clean(row[c.load_class]) || null) : null;
    const note = c.note != null ? (clean(row[c.note]) || null) : null;
    const pallet_weight_kg = c.pallet_weight != null ? numeric(row[c.pallet_weight]) : null;

    items.push({
      source: cfg.source,
      article,
      name,
      series,
      load_class,
      dn,
      length_mm: dims.length_mm,
      width_mm: dims.width_mm,
      height_mm: dims.height_mm,
      volume_m3: resolveVolume(c.volume != null ? row[c.volume] : null, dims),
      weight_kg: weight,
      qty_per_pallet: c.qty_per_pallet != null ? intOrNull(row[c.qty_per_pallet]) : null,
      pallet_weight_kg: pallet_weight_kg != null && pallet_weight_kg > 0 ? pallet_weight_kg : null,
      note,
      norm_key: normKey([article, name, series, dn, load_class].filter(Boolean).join(' ')),
    });
  }
  return items;
}

function parseTrucksFromSheet(rows, cfg) {
  const trucks = [];
  const c = cfg.col;
  for (let i = cfg.dataStart; i < rows.length; i++) {
    const row = rows[i] || [];
    const name = clean(row[c.name]);
    const payload = row[c.payload_t];
    // Только строки с числовой грузоподъёмностью — легенда ниже («тоннаж/европалет/…»)
    // держит в этой колонке текст и отсекается.
    if (!name || typeof payload !== 'number' || !Number.isFinite(payload)) continue;
    trucks.push({
      name,
      payload_t: payload,
      volume_m3: numeric(row[c.volume_m3]),
      inner_length_m: numeric(row[c.inner_length_m]),
      inner_width_m: numeric(row[c.inner_width_m]),
      inner_height_m: numeric(row[c.inner_height_m]),
      pallet_places: intOrNull(row[c.pallet_places]),
    });
  }
  return trucks;
}

// ── Публичное API ─────────────────────────────────────────────────────────────

// Парсит один файл: применяет к нему подходящие source-конфиги (по имени файла)
// и, если это «Распаллетка», справочник машин. Возвращает { items, trucks }.
function parseLogisticsFile(filePath) {
  const base = path.basename(filePath).normalize('NFC');
  const workbook = XLSX.readFile(filePath);
  const items = [];
  const trucks = [];

  for (const cfg of SOURCES) {
    if (!cfg.filePattern.test(base)) continue;
    const rows = sheetRows(workbook, cfg.sheet);
    if (!rows) continue;
    items.push(...parseItemsFromSheet(rows, cfg));
  }

  if (TRUCK_SOURCE.filePattern.test(base)) {
    const rows = sheetRows(workbook, TRUCK_SOURCE.sheet);
    if (rows) trucks.push(...parseTrucksFromSheet(rows, TRUCK_SOURCE));
  }

  return { items, trucks };
}

// Имена файлов могут быть в NFD (macOS/копирование) — сравниваем в NFC.
const KNOWN_FILES = [
  /вес.*паллет.*пластик.*\.xlsx$/iu,
  /распал.*\.xlsx$/iu,
  /паллетировка.*\.ods$/iu,
];

function findLogisticsFiles(rootDir) {
  return fs.readdirSync(rootDir)
    .filter((n) => KNOWN_FILES.some((re) => re.test(n.normalize('NFC'))))
    .map((n) => path.join(rootDir, n));
}

// Находит все три файла в корне, парсит каждый, объединяет позиции и машины.
function parseAllLogistics(rootDir) {
  const files = findLogisticsFiles(rootDir);
  const items = [];
  const trucks = [];
  for (const file of files) {
    const parsed = parseLogisticsFile(file);
    items.push(...parsed.items);
    trucks.push(...parsed.trucks);
  }
  return { items, trucks, files: files.map((f) => path.basename(f)) };
}

module.exports = {
  SOURCES,
  parseDimsString,
  parseLogisticsFile,
  parseAllLogistics,
  findLogisticsFiles,
};

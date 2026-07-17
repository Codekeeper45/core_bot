'use strict';
// Детерминированный разбор финансовой выгрузки (1С и любой Excel/CSV) — задачи
// экономиста считаются в чистом JS, а не «на глаз» моделью, чтобы цифры были
// точными. Формат 1С заранее неизвестен, поэтому маппинг колонок передаёт
// модель, выведя его из распарсенного образца. Три режима определения
// доходов/расходов покрывают типичные выгрузки (две колонки Дебет|Кредит,
// одна колонка суммы + колонка типа, одна колонка со знаком).
const XLSX = require('xlsx');

// ── Парсинг чисел в стиле 1С: «1 234,56», NBSP, «(1 234)» = отрицательное ──────
function parseNum(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  let s = String(value).trim();
  if (!s) return null;
  let sign = 1;
  if (/^\(.*\)$/.test(s)) { sign = -1; s = s.slice(1, -1); }
  s = s.replace(/ /g, '').replace(/\s/g, ''); // убрать пробелы-разделители тысяч
  s = s.replace(/[^\d.,\-]/g, '');                  // убрать валюту и прочее
  if (s.includes(',') && s.includes('.')) s = s.replace(/\./g, '').replace(',', '.'); // 1.234,56 → 1234.56
  else s = s.replace(',', '.');
  if (s === '' || s === '-' || s === '.') return null;
  const n = Number(s);
  return Number.isFinite(n) ? sign * n : null;
}

function monthKey(value) {
  if (value instanceof Date && !isNaN(value)) {
    return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}`;
  }
  const s = String(value || '').trim();
  let m = s.match(/^(\d{4})[-/.](\d{1,2})/);          // 2026-06-01, 2026/6
  if (m) return `${m[1]}-${String(m[2]).padStart(2, '0')}`;
  m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})/); // 01.06.2026 / 1.6.26
  if (m) {
    const year = m[3].length === 2 ? `20${m[3]}` : m[3];
    return `${year}-${String(m[2]).padStart(2, '0')}`;
  }
  return null;
}

function colLetterToIndex(letter) {
  let idx = 0;
  const up = letter.toUpperCase();
  for (let i = 0; i < up.length; i++) idx = idx * 26 + (up.charCodeAt(i) - 64);
  return idx - 1;
}

// id колонки: число (0-based индекс) | буква Excel (A/B/AA) | имя из шапки.
function resolveCol(id, header) {
  if (id == null || id === '') return -1;
  if (typeof id === 'number' && Number.isInteger(id)) return id >= 0 ? id : -1;
  const s = String(id).trim();
  if (/^\d+$/.test(s)) return Number(s);
  if (/^[A-Za-z]{1,3}$/.test(s)) return colLetterToIndex(s);
  const norm = (v) => String(v == null ? '' : v).trim().toLowerCase();
  const target = norm(s);
  let idx = header.findIndex((h) => norm(h) === target);
  if (idx < 0) idx = header.findIndex((h) => norm(h).includes(target) && target.length >= 2);
  return idx;
}

function toRows(input) {
  const opts = { type: input.buffer ? 'buffer' : 'string', cellDates: true, raw: true };
  const wb = XLSX.read(input.buffer || input.text, opts);
  const sheetName = (input.sheet && wb.Sheets[input.sheet]) ? input.sheet : wb.SheetNames[0];
  const sheet = wb.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: '' });
  return { rows, sheetName, sheetNames: wb.SheetNames };
}

function matchesAny(value, list) {
  const v = String(value == null ? '' : value).trim().toLowerCase();
  if (!v) return false;
  return list.some((token) => v.includes(String(token).trim().toLowerCase()));
}

// mapping: { sheet?, header_row=1, date_col?,
//   income_col & expense_col                          — режим «две колонки»
//   | amount_col & type_col & income_when[] & expense_when[]  — режим «тип»
//   | amount_col & sign_rule('positive_income'|'negative_income') — режим «знак» }
function analyzeFinance(input, mapping = {}) {
  const { rows, sheetName, sheetNames } = toRows({ buffer: input.buffer, text: input.text, sheet: mapping.sheet });
  const headerRow = Math.max(1, Number(mapping.header_row) || 1);
  const header = rows[headerRow - 1] || [];
  const data = rows.slice(headerRow);

  const incomeIdx = resolveCol(mapping.income_col ?? mapping.credit_col, header);
  const expenseIdx = resolveCol(mapping.expense_col ?? mapping.debit_col, header);
  const amountIdx = resolveCol(mapping.amount_col, header);
  const typeIdx = resolveCol(mapping.type_col, header);
  const dateIdx = resolveCol(mapping.date_col, header);

  let mode = null;
  if (incomeIdx >= 0 && expenseIdx >= 0) mode = 'two_columns';
  else if (amountIdx >= 0 && typeIdx >= 0) mode = 'typed';
  else if (amountIdx >= 0 && mapping.sign_rule) mode = 'signed';
  if (!mode) {
    return { error: 'bad_mapping', message: 'Не хватает маппинга: нужны income_col+expense_col, либо amount_col+type_col+income_when/expense_when, либо amount_col+sign_rule.', columns: header };
  }

  const incomeWhen = Array.isArray(mapping.income_when) ? mapping.income_when : [];
  const expenseWhen = Array.isArray(mapping.expense_when) ? mapping.expense_when : [];
  const signRule = mapping.sign_rule === 'negative_income' ? 'negative_income' : 'positive_income';

  let income = 0, expense = 0, rowsUsed = 0, rowsSkipped = 0;
  const byMonth = new Map();
  const columnTotals = {};

  const addMonth = (key, incAdd, expAdd) => {
    if (!key) return;
    const cur = byMonth.get(key) || { income: 0, expense: 0, rows: 0 };
    cur.income += incAdd; cur.expense += expAdd; cur.rows += 1;
    byMonth.set(key, cur);
  };

  for (const row of data) {
    if (!Array.isArray(row) || row.every((c) => c === '' || c == null)) continue;

    // Итоги по КАЖДОЙ числовой колонке (даёт «дебет/кредит» и любые суммы даром).
    for (let c = 0; c < Math.max(header.length, row.length); c++) {
      const n = parseNum(row[c]);
      if (n != null) {
        const label = String(header[c] == null || header[c] === '' ? `col${c + 1}` : header[c]).trim();
        columnTotals[label] = (columnTotals[label] || 0) + n;
      }
    }

    let inc = 0, exp = 0, counted = false;
    if (mode === 'two_columns') {
      inc = parseNum(row[incomeIdx]) || 0;
      exp = parseNum(row[expenseIdx]) || 0;
      counted = inc !== 0 || exp !== 0;
    } else {
      const amt = parseNum(row[amountIdx]);
      if (amt != null) {
        if (mode === 'typed') {
          if (matchesAny(row[typeIdx], incomeWhen)) { inc = Math.abs(amt); counted = true; }
          else if (matchesAny(row[typeIdx], expenseWhen)) { exp = Math.abs(amt); counted = true; }
        } else { // signed
          const isIncome = signRule === 'positive_income' ? amt >= 0 : amt < 0;
          if (isIncome) inc = Math.abs(amt); else exp = Math.abs(amt);
          counted = true;
        }
      }
    }

    if (!counted) { rowsSkipped++; continue; }
    income += inc; expense += exp; rowsUsed++;
    if (dateIdx >= 0) addMonth(monthKey(row[dateIdx]), inc, exp);
  }

  const round = (n) => Number(n.toFixed(2));
  const by_month = [...byMonth.entries()].sort((a, b) => a[0].localeCompare(b[0]))
    .map(([month, v]) => ({ month, income: round(v.income), expense: round(v.expense), balance: round(v.income - v.expense), rows: v.rows }));
  const column_totals = {};
  for (const k of Object.keys(columnTotals)) column_totals[k] = round(columnTotals[k]);

  return {
    mode, sheet: sheetName, sheets: sheetNames,
    income: round(income), expense: round(expense), balance: round(income - expense),
    rows_used: rowsUsed, rows_skipped: rowsSkipped,
    columns: header.map((h) => String(h == null ? '' : h)),
    column_totals,
    by_month,
  };
}

module.exports = { analyzeFinance, _internals: { parseNum, monthKey, resolveCol, colLetterToIndex } };

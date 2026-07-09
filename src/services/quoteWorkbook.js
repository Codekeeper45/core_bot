'use strict';

// Рендерим прямо в XLSX-пакет, а не пересобираем через SheetJS: так остаются
// логотипы, стили и настройки печати исходного коммерческого предложения.
const fs = require('fs');
const path = require('path');
const JSZip = require('jszip');

const TEMPLATE_PATH = path.join(__dirname, '..', 'templates', 'neodrain-quote.xlsx');
const SHEET_PATH = 'xl/worksheets/sheet1.xml';
const TERMS_SLOTS = 7;
const MAX_LINES = 50;

function xmlEscape(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function inlineCell(address, style, value) {
  return `<c r="${address}" s="${style}" t="inlineStr"><is><t xml:space="preserve">${xmlEscape(value)}</t></is></c>`;
}

function numericCell(address, style, value, formula = null) {
  const formulaXml = formula ? `<f>${xmlEscape(formula)}</f>` : '';
  return `<c r="${address}" s="${style}">${formulaXml}<v>${Number(value)}</v></c>`;
}

function displayDimension(value) {
  if (value == null || value === '') return '-';
  const number = Number(value);
  return Number.isFinite(number) ? number : String(value);
}

function cellStyle(rowXml, address, fallback) {
  const cell = rowXml.match(new RegExp(`<c\\b[^>]*\\br="${address}"[^>]*`, 'i'));
  const style = cell && cell[0].match(/\bs="(\d+)"/i);
  return style ? style[1] : fallback;
}

function replaceCell(rowXml, address, replacement) {
  const re = new RegExp(`<c\\b[^>]*\\br="${address}"[^>]*(?:/>|>[\\s\\S]*?<\\/c>)`, 'i');
  if (!re.test(rowXml)) throw new Error(`quote_template_missing_cell:${address}`);
  return rowXml.replace(re, replacement);
}

function replaceWithInline(rowXml, address, value, fallbackStyle) {
  return replaceCell(rowXml, address, inlineCell(address, cellStyle(rowXml, address, fallbackStyle), value));
}

function shiftRow(rowXml, offset) {
  return rowXml
    .replace(/(<row\b[^>]*\br=")(\d+)(")/i, (_, before, row, after) => `${before}${Number(row) + offset}${after}`)
    .replace(/(<c\b[^>]*\br="[A-Z]+)(\d+)(")/gi, (_, before, row, after) => `${before}${Number(row) + offset}${after}`);
}

function rowNumber(rowXml) {
  const match = rowXml.match(/<row\b[^>]*\br="(\d+)"/i);
  return match ? Number(match[1]) : null;
}

function rowsFromSheet(sheetXml) {
  const match = sheetXml.match(/<sheetData>([\s\S]*?)<\/sheetData>/i);
  if (!match) throw new Error('quote_template_missing_sheet_data');
  const rows = match[1].match(/<row\b[^>]*(?:\/>|>[\s\S]*?<\/row>)/gi) || [];
  const byNumber = new Map(rows.map((row) => [rowNumber(row), row]));
  for (const required of [8, 11, 12, 13, 16, 17, 23, 26]) {
    if (!byNumber.has(required)) throw new Error(`quote_template_missing_row:${required}`);
  }
  return { match, rows, byNumber };
}

function lineName(line) {
  const details = [];
  if (line.sku) details.push(`арт. ${line.sku}`);
  if (line.supplier_label) details.push(line.supplier_label);
  return details.length ? `${line.name} (${details.join('; ')})` : line.name;
}

function lineRow(row, index, line) {
  const values = [line.length_mm, line.width_mm, line.dn, line.height_mm].map(displayDimension);
  const dataCell = (column, style, value) => (typeof value === 'number'
    ? numericCell(`${column}${row}`, style, value)
    : inlineCell(`${column}${row}`, style, value));
  return `<row r="${row}" spans="1:13" ht="30" customHeight="1" thickBot="1" x14ac:dyDescent="0.35">`
    + numericCell(`A${row}`, 23, index)
    + inlineCell(`B${row}`, 14, lineName(line))
    + dataCell('C', 15, values[0])
    + dataCell('D', 15, values[1])
    + dataCell('E', 15, values[2])
    + dataCell('F', 15, values[3])
    + numericCell(`G${row}`, 16, line.qty)
    + inlineCell(`H${row}`, 17, 'шт')
    + numericCell(`I${row}`, 18, line.unit_price)
    + numericCell(`J${row}`, 18, line.line_total, `I${row}*G${row}`)
    + '</row>';
}

function replaceMergeCells(sheetXml, itemCount) {
  const totalRow = 13 + itemCount;
  const firstTermRow = totalRow + 1;
  const signatureRow = totalRow + 10;
  const refs = ['A4:B4', 'B8:B9', 'B11:I11', 'H10:I10', `H${totalRow}:I${totalRow}`];
  for (let row = firstTermRow; row < firstTermRow + TERMS_SLOTS; row++) refs.push(`B${row}:I${row}`);
  refs.push(`B${signatureRow}:I${signatureRow}`);
  const mergeXml = `<mergeCells count="${refs.length}">${refs.map((ref) => `<mergeCell ref="${ref}"/>`).join('')}</mergeCells>`;
  return sheetXml.replace(/<mergeCells\b[^>]*>[\s\S]*?<\/mergeCells>/i, mergeXml);
}

function replaceDimension(sheetXml, itemCount) {
  const lastRow = 36 + (itemCount - 3);
  return sheetXml.replace(/<dimension\b[^>]*\bref="[^"]*"[^>]*\/>/i, `<dimension ref="A4:M${lastRow}"/>`);
}

function renderSheet(sheetXml, quote) {
  const { match, rows, byNumber } = rowsFromSheet(sheetXml);
  const itemCount = quote.lines.length;
  const offset = itemCount - 3;
  const totalRowNumber = 13 + itemCount;
  const terms = quote.terms.concat(Array(Math.max(0, TERMS_SLOTS - quote.terms.length)).fill(''));
  const outputRows = [];

  for (const row of rows) {
    const number = rowNumber(row);
    if (number >= 13 && number <= 16) continue;
    let next = row;
    if (number === 8) next = replaceWithInline(next, 'B8', `Исходящий №${quote.quote_number}\nот ${quote.offer_date}`, 28);
    if (number === 11) next = replaceWithInline(next, 'B11', `Уважаемый(ая) ${quote.recipient}, просим рассмотреть данное коммерческое предложение:`, 26);
    if (number >= 17 && number < 17 + TERMS_SLOTS) {
      next = replaceWithInline(next, `B${number}`, terms[number - 17], 27);
    }
    if (number >= 17) next = shiftRow(next, offset);
    outputRows.push(next);
    if (number === 12) {
      for (let i = 0; i < itemCount; i++) outputRows.push(lineRow(13 + i, i + 1, quote.lines[i]));
      let totalRow = replaceCell(
        byNumber.get(16),
        'J16',
        numericCell(`J16`, cellStyle(byNumber.get(16), 'J16', 22), quote.total, `SUM(J13:J${12 + itemCount})`)
      );
      totalRow = shiftRow(totalRow, offset);
      outputRows.push(totalRow);
    }
  }

  let output = sheetXml.replace(match[0], `<sheetData>${outputRows.join('')}</sheetData>`);
  output = replaceMergeCells(output, itemCount);
  return replaceDimension(output, itemCount);
}

async function forceRecalculation(zip) {
  const workbook = await zip.file('xl/workbook.xml').async('string');
  const calcPr = '<calcPr calcId="0" fullCalcOnLoad="1" forceFullCalc="1"/>';
  zip.file('xl/workbook.xml', /<calcPr\b[^>]*\/>/i.test(workbook)
    ? workbook.replace(/<calcPr\b[^>]*\/>/i, calcPr)
    : workbook.replace('</workbook>', `${calcPr}</workbook>`));

  const rels = await zip.file('xl/_rels/workbook.xml.rels').async('string');
  zip.file('xl/_rels/workbook.xml.rels', rels.replace(/<Relationship\b[^>]*\bTarget="calcChain\.xml"[^>]*\/>/i, ''));
  const contentTypes = await zip.file('[Content_Types].xml').async('string');
  zip.file('[Content_Types].xml', contentTypes.replace(/<Override\b[^>]*\bPartName="\/xl\/calcChain\.xml"[^>]*\/>/i, ''));
  zip.remove('xl/calcChain.xml');
}

async function renderQuote(quote) {
  if (!fs.existsSync(TEMPLATE_PATH)) throw new Error('quote_template_missing');
  if (!Array.isArray(quote.lines) || quote.lines.length < 1 || quote.lines.length > MAX_LINES) {
    throw new Error('quote_invalid_line_count');
  }
  if (!Array.isArray(quote.terms) || quote.terms.length < 1 || quote.terms.length > TERMS_SLOTS) {
    throw new Error('quote_invalid_terms');
  }
  const zip = await JSZip.loadAsync(fs.readFileSync(TEMPLATE_PATH));
  const sheet = zip.file(SHEET_PATH);
  if (!sheet) throw new Error('quote_template_missing_sheet');
  zip.file(SHEET_PATH, renderSheet(await sheet.async('string'), quote));

  // Старые строки образца больше не используются, но убираем бренд и из XML,
  // чтобы он не попадал в текстовый экспорт созданного КП.
  const shared = zip.file('xl/sharedStrings.xml');
  if (shared) zip.file('xl/sharedStrings.xml', (await shared.async('string')).replace(/Gidrolica/gi, 'NEODRAIN'));
  await forceRecalculation(zip);
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } });
}

module.exports = { renderQuote, TEMPLATE_PATH, MAX_LINES, TERMS_SLOTS };

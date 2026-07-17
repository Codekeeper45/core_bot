'use strict';
// Сборка и правка .docx через jszip+XML — БЕЗ внешних библиотек генерации Word.
// Та же техника, что в quoteWorkbook.js для .xlsx: .docx это zip с XML внутри,
// правим строку word/document.xml и сохраняем стили/таблицы оригинала.
//
//  buildDocx(spec)          → Buffer нового документа, собранного из структуры.
//  editDocx(buffer, edits)  → { buffer, changed, hits, notFound } — точечная
//                             правка присланного договора на месте.
const JSZip = require('jszip');

const W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const DOC_XML_PATH = 'word/document.xml';

// ── XML helpers ──────────────────────────────────────────────────────────────
function xmlEscape(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// Декод для сравнения текста <w:t> с искомой строкой (&amp; — последним).
function xmlDecode(value) {
  return String(value)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

// ── Сборка нового документа из структуры (spec.blocks) ───────────────────────
const HEADING_SZ = { 1: 36, 2: 30, 3: 26 }; // half-points

function runXml(text, { bold, italic, sz } = {}) {
  const rpr = (bold || italic || sz)
    ? `<w:rPr>${bold ? '<w:b/>' : ''}${italic ? '<w:i/>' : ''}${sz ? `<w:sz w:val="${sz}"/><w:szCs w:val="${sz}"/>` : ''}</w:rPr>`
    : '';
  return `<w:r>${rpr}<w:t xml:space="preserve">${xmlEscape(text)}</w:t></w:r>`;
}

function paragraphXml(text, opts = {}) {
  const { bold, italic, sz, before, after, align } = opts;
  const spacing = (before || after)
    ? `<w:spacing${before ? ` w:before="${before}"` : ''}${after ? ` w:after="${after}"` : ''}/>` : '';
  const jc = align ? `<w:jc w:val="${align}"/>` : '';
  const ppr = (spacing || jc) ? `<w:pPr>${spacing}${jc}</w:pPr>` : '';
  return `<w:p>${ppr}${runXml(text, { bold, italic, sz })}</w:p>`;
}

const TABLE_BORDERS = ['top', 'left', 'bottom', 'right', 'insideH', 'insideV']
  .map((edge) => `<w:${edge} w:val="single" w:sz="4" w:space="0" w:color="auto"/>`)
  .join('');

function tableXml(rows, header) {
  const tblPr = `<w:tblPr><w:tblW w:w="0" w:type="auto"/><w:tblBorders>${TABLE_BORDERS}</w:tblBorders></w:tblPr>`;
  const trs = rows.map((row, ri) => {
    const isHeader = header && ri === 0;
    const cells = (Array.isArray(row) ? row : [row]).map((cell) => {
      const rpr = isHeader ? '<w:rPr><w:b/></w:rPr>' : '';
      const run = `<w:r>${rpr}<w:t xml:space="preserve">${xmlEscape(cell == null ? '' : String(cell))}</w:t></w:r>`;
      return `<w:tc><w:tcPr/><w:p>${run}</w:p></w:tc>`;
    }).join('');
    return `<w:tr>${cells}</w:tr>`;
  }).join('');
  // После таблицы Word требует абзац — добавляем пустой.
  return `<w:tbl>${tblPr}${trs}</w:tbl><w:p/>`;
}

const SECT_PR = '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/>'
  + '<w:pgMar w:top="1134" w:right="850" w:bottom="1134" w:left="1134" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr>';

function blockToXml(block) {
  if (!block || typeof block !== 'object') return '';
  const type = String(block.type || 'paragraph');
  if (type === 'heading') {
    const level = Math.min(3, Math.max(1, Number(block.level) || 1));
    return paragraphXml(String(block.text || ''), { bold: true, sz: HEADING_SZ[level], before: 200, after: 100 });
  }
  if (type === 'table' && Array.isArray(block.rows) && block.rows.length) {
    const rows = block.rows.slice(0, 200).map((r) => (Array.isArray(r) ? r.slice(0, 20) : [r]));
    return tableXml(rows, block.header === true);
  }
  // paragraph (по умолчанию)
  return paragraphXml(String(block.text || ''), {
    bold: block.bold === true, italic: block.italic === true,
    align: block.align === 'center' || block.align === 'right' || block.align === 'both' ? block.align : undefined,
  });
}

function buildDocx(spec = {}) {
  const blocks = Array.isArray(spec.blocks) ? spec.blocks.slice(0, 400) : [];
  const parts = [];
  if (spec.title) parts.push(paragraphXml(String(spec.title), { bold: true, sz: 44, align: 'center', after: 200 }));
  for (const block of blocks) {
    const xml = blockToXml(block);
    if (xml) parts.push(xml);
  }
  if (!parts.length) parts.push('<w:p/>'); // не оставляем пустое тело
  const body = `${parts.join('')}${SECT_PR}`;
  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n`
    + `<w:document xmlns:w="${W_NS}"><w:body>${body}</w:body></w:document>`;

  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n`
    + `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">`
    + `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>`
    + `<Default Extension="xml" ContentType="application/xml"/>`
    + `<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>`
    + `</Types>`;
  const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n`
    + `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`
    + `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>`
    + `</Relationships>`;

  const zip = new JSZip();
  zip.file('[Content_Types].xml', contentTypes);
  zip.file('_rels/.rels', rels);
  zip.file('word/document.xml', documentXml);
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

// ── Хирургическая правка присланного .docx ──────────────────────────────────
// Внутри абзаца текст размазан по нескольким <w:r>/<w:t>. Собираем полный текст
// абзаца, применяем замены, весь результат кладём в ПЕРВЫЙ <w:t> (с его
// форматированием), остальные обнуляем. Так стили/таблицы/шапки целы, а разрыв
// строки по run'ам не мешает поиску. Ограничение: сложное инлайн-форматирование
// внутри заменяемого участка нормализуется к стилю первого run; совпадение,
// пересекающее границу абзацев, не обрабатывается.
function editParagraph(pXml, edits, hits) {
  const tRe = /(<w:t\b[^>]*>)([\s\S]*?)(<\/w:t>)/g;
  const segs = [];
  let m;
  while ((m = tRe.exec(pXml))) segs.push({ open: m[1], text: m[2], close: m[3], index: m.index, len: m[0].length });
  if (!segs.length) return pXml;
  const full = segs.map((s) => xmlDecode(s.text)).join('');
  let next = full;
  for (const { find, replace } of edits) {
    if (!find) continue;
    if (next.includes(find)) {
      hits[find] = (hits[find] || 0) + (next.split(find).length - 1);
      next = next.split(find).join(replace == null ? '' : String(replace));
    }
  }
  if (next === full) return pXml;
  let out = '';
  let cursor = 0;
  segs.forEach((s, i) => {
    out += pXml.slice(cursor, s.index);
    let open = s.open;
    if (i === 0 && !/xml:space=/.test(open)) open = open.replace(/>\s*$/, ' xml:space="preserve">');
    out += open + (i === 0 ? xmlEscape(next) : '') + s.close;
    cursor = s.index + s.len;
  });
  out += pXml.slice(cursor);
  return out;
}

async function editDocx(buffer, edits) {
  const list = (Array.isArray(edits) ? edits : [])
    .map((e) => ({ find: String((e && e.find) || ''), replace: e && e.replace }))
    .filter((e) => e.find);
  if (!list.length) return { buffer: null, changed: false, hits: {}, notFound: [], reason: 'no_edits' };

  let zip;
  try {
    zip = await JSZip.loadAsync(buffer);
  } catch (_) {
    return { buffer: null, changed: false, hits: {}, notFound: [], reason: 'not_zip' };
  }
  const docFile = zip.file(DOC_XML_PATH);
  if (!docFile) return { buffer: null, changed: false, hits: {}, notFound: [], reason: 'not_word' };

  const xml = await docFile.async('string');
  const hits = {};
  const newXml = xml.replace(/<w:p\b[^>]*>[\s\S]*?<\/w:p>/g, (p) => editParagraph(p, list, hits));
  const changed = newXml !== xml;
  const notFound = list.filter((e) => !hits[e.find]).map((e) => e.find);
  if (!changed) return { buffer: null, changed: false, hits, notFound, reason: 'no_match' };

  zip.file(DOC_XML_PATH, newXml);
  const out = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  return { buffer: out, changed: true, hits, notFound };
}

module.exports = { buildDocx, editDocx, _internals: { xmlEscape, xmlDecode, editParagraph } };

'use strict';
// Как показывать артикул позиции прайса НАРУЖУ (боту/в КП):
// - есть source_sku (например «новинка») → показываем его дословно;
// - синтетический ключ AQ-/GD-NOVINKA-/NOART- (служебный, для уникальности) → null
//   (позиция без артикула — бот так и скажет «без артикула», не выдумывая код);
// - иначе → реальный артикул как в прайсе.
function displayArticle(item) {
  if (!item) return null;
  if (item.source_sku) return item.source_sku;
  if (/^(?:AQ|GD)-(NOVINKA|NOART)-/i.test(String(item.sku || ''))) return null;
  return item.sku || null;
}

// Человекочитаемое имя каталога поставщика — бот называет его в каждом ответе о цене.
const SUPPLIER_LABELS = {
  aquastok: 'Аквасток / Norma (Январь 2026)',
  gidrolica: 'Gidrolica (июль 2025)',
};

function supplierLabel(supplier) {
  if (!supplier) return null;
  return SUPPLIER_LABELS[String(supplier).toLowerCase()] || String(supplier);
}

module.exports = { displayArticle, supplierLabel };

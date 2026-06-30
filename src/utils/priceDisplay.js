'use strict';
// Как показывать артикул позиции прайса НАРУЖУ (боту/в КП):
// - есть source_sku (например «новинка») → показываем его дословно;
// - синтетический ключ AQ-NOVINKA-/AQ-NOART- (служебный, для уникальности) → null
//   (позиция без артикула — бот так и скажет «без артикула», не выдумывая код);
// - иначе → реальный артикул как в прайсе.
function displayArticle(item) {
  if (!item) return null;
  if (item.source_sku) return item.source_sku;
  if (/^AQ-(NOVINKA|NOART)-/i.test(String(item.sku || ''))) return null;
  return item.sku || null;
}

module.exports = { displayArticle };

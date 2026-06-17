'use strict';
// Нормализованный ключ позиции склада — для поиска и дедупа. Регистр/пунктуация/ё не
// должны разводить «ДН100Н260» и «дн100 н260» в разные товары. Чистая функция.
function normKey(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^a-zа-я0-9]+/gi, ' ') // выкинуть пунктуацию/спецсимволы
    .replace(/\s+/g, ' ')
    .trim();
}

// Токены запроса для поиска (AND по каждому): «аквасток дн200» → ['аквасток','дн200'].
function queryTokens(query) {
  return normKey(query).split(' ').filter(Boolean);
}

module.exports = { normKey, queryTokens };

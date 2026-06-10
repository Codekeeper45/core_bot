'use strict';
// Единый ответ инструмента при сбое БД — чтобы бот говорил боссу «временный сбой»,
// а не ложное «не найдено». Использование:
//   try { ...body... } catch (err) { return handleToolDbError(err); }
// Не-БД ошибки пробрасываются дальше (их ловит агентный цикл).
function dbErrorResult() {
  return { success: false, error: 'db', message: 'Временный сбой БД, повтори позже.' };
}

function handleToolDbError(err) {
  if (err && err.dbError) return dbErrorResult();
  throw err;
}

module.exports = { dbErrorResult, handleToolDbError };

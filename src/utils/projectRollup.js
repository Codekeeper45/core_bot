'use strict';
// Чистая логика статуса проекта из агрегата задач — вынесена для тестируемости.
// done — все задачи завершены или отменены; blocked — есть заблокированные; иначе active.
function rollupStatus({ total = 0, done = 0, cancelled = 0, blocked = 0 } = {}) {
  if (total > 0 && (done + cancelled) === total) return 'done';
  if (blocked > 0) return 'blocked';
  return 'active';
}

module.exports = { rollupStatus };

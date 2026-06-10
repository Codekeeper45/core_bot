'use strict';
// Зависимости задач (orch_tasks.depends_on = CSV из id).
// Используется и dispatch_task (гейт), и project_status (сводка) — единый источник истины.

// Парсит CSV depends_on в массив числовых id.
function parseDeps(dependsOn) {
  return String(dependsOn || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map(Number)
    .filter((n) => Number.isFinite(n));
}

// Возвращает id зависимостей задачи, которые ещё НЕ выполнены (не в статусе done).
// task: { depends_on }, siblings: [{ id, status }] — задачи того же проекта.
function unmetDeps(task, siblings) {
  const deps = parseDeps(task && task.depends_on);
  if (!deps.length) return [];
  const doneIds = new Set(
    (siblings || []).filter((t) => t.status === 'done').map((t) => Number(t.id))
  );
  return deps.filter((d) => !doneIds.has(d));
}

module.exports = { parseDeps, unmetDeps };

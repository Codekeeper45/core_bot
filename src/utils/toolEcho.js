'use strict';
// Человекочитаемое «эхо» вызова инструмента — чтобы в чате сразу было видно,
// что именно делает бот и какой тул дёргает. Возвращает короткую строку (или ''),
// которую бот шлёт в чат ПЕРЕД выполнением действия.

function s(v, n = 80) {
  const t = String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n) + '…' : t;
}

function formatToolEcho(name, args = {}) {
  const a = args || {};
  switch (name) {
    case 'list_employees':
      return '📋 Смотрю список сотрудников и их загрузку';
    case 'employee_profile':
      return '📇 Смотрю профиль сотрудника';
    case 'create_project': {
      const n = Array.isArray(a.tasks) ? a.tasks.length : 0;
      return `🗂 Составляю план «${s(a.title || a.goal || 'без названия', 60)}» (${n} задач)`;
    }
    case 'assign_task':
      return `👤 Назначаю задачу #${a.task_id} → сотрудник #${a.employee_id}`;
    case 'dispatch_task':
      return `📨 Отправляю задачу #${a.task_id} исполнителю`;
    case 'update_task':
      return `✏️ Обновляю задачу #${a.task_id} → статус «${s(a.status, 24)}»`;
    case 'project_status':
      return a.project_id ? `📊 Смотрю статус плана #${a.project_id}` : '📊 Смотрю список планов';
    case 'revise_project':
      return `♻️ Пересматриваю план #${a.project_id}`;
    case 'message_boss':
      return '📤 Передаю сообщение руководителю';
    case 'message_employee':
      return a.to_all
        ? `📣 Пишу всем: ${s(a.to, 40)}`
        : `✉️ Пишу сотруднику: ${s(a.to, 40)}`;
    case 'manage_employees':
      return `🛠 Обновляю штат (${s(a.action || 'изменение', 24)})`;
    case 'get_current_time':
      return '🕐 Сверяю текущее время';
    default:
      return `🔧 ${s(name, 40)}`;
  }
}

module.exports = { formatToolEcho };

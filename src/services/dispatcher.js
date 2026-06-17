'use strict';
// Общая логика диспатча подзадачи — чтобы её могли использовать и инструмент
// dispatch_task (ручной диспатч боссом), и update_task (авто-продвижение DAG:
// задача завершена → автоматически рассылаем готовых преемников).
const { getTask, getEmployeeById, markDispatched, listTasksForProject } = require('./mysql');
const { deliver } = require('./notifier');
const { unmetDeps } = require('../utils/deps');

// Бриф из полей задачи (для авто-диспатча, когда LLM не пишет текст вручную).
function briefFromTask(task) {
  const parts = [];
  if (task.description) parts.push(String(task.description));
  if (task.expected) parts.push(`Ожидаем: ${task.expected}`);
  if (task.deadline) parts.push(`Срок: ${task.deadline}`);
  return parts.join('\n') || 'Приступай к задаче.';
}

// Отправить одну задачу назначенному исполнителю. message — готовый бриф.
// Возвращает структуру результата (как у инструмента dispatch_task).
async function dispatchTaskById(taskId, message) {
  const task = await getTask(taskId);
  if (!task) return { success: false, message: `Задача ${taskId} не найдена.` };
  if (!task.assignee_id) {
    return { success: false, task_id: taskId, reason: 'no_assignee', message: 'Сначала назначь исполнителя (assign_task).' };
  }

  // Гейт зависимостей: не диспатчим, пока предшественники не завершены.
  const siblings = await listTasksForProject(task.project_id);
  const waiting = unmetDeps(task, siblings);
  if (waiting.length) {
    return {
      success: false, task_id: taskId, reason: 'blocked_by_deps', waiting_on: waiting,
      message: `Задача #${task.id} ждёт завершения зависимостей: ${waiting.map((id) => '#' + id).join(', ')}. Диспатч отложен.`,
    };
  }

  const emp = await getEmployeeById(task.assignee_id);
  if (!emp) return { success: false, message: `Сотрудник ${task.assignee_id} не найден.` };

  const fullMsg = `Задача #${task.id}: ${task.title}\n${message}`;

  // Тестовый сотрудник (нет канала/контакта) — только запись.
  if (!emp.channel || !emp.contact) {
    await markDispatched(taskId, false);
    return {
      success: true, task_id: taskId, task_title: task.title, dispatched: true, sent: false, employee: emp.name,
      note: 'тестовый сотрудник — диспатч записан, сообщение не отправлено',
    };
  }

  const ok = await deliver(emp.channel, emp.contact, fullMsg, null, { record: true });
  await markDispatched(taskId, ok);
  return {
    success: true, task_id: taskId, task_title: task.title, dispatched: true, sent: ok, employee: emp.name,
    note: ok ? 'доставлено' : 'ошибка отправки (см. логи)',
  };
}

// Авто-продвижение DAG: после завершения задачи разослать всех преемников,
// у которых теперь сняты зависимости (assignee есть, ещё не диспатчены).
// Возвращает список авто-отправленных (для уведомления босса).
async function dispatchReadySuccessors(projectId) {
  const tasks = await listTasksForProject(projectId);
  const ready = tasks.filter((t) =>
    t.assignee_id
    && !t.dispatched
    && (t.status === 'todo' || t.status === 'new')
    && unmetDeps(t, tasks).length === 0);

  const sent = [];
  for (const t of ready) {
    const full = await getTask(t.id); // нужны description/expected/deadline целиком
    const res = await dispatchTaskById(t.id, briefFromTask(full || t));
    if (res && res.dispatched) {
      sent.push({ task_id: t.id, title: t.title, employee: res.employee, sent: res.sent });
    }
  }
  return sent;
}

module.exports = { dispatchTaskById, dispatchReadySuccessors, briefFromTask };

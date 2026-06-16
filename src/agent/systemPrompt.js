'use strict';
const fs = require('fs');
const path = require('path');
const config = require('../config');
const { findEmployeeByContact, getOpenTasksForEmployee, listFacts } = require('../services/mysql');

const SYSTEM_PROMPT_RAW = fs.readFileSync(
  path.join(__dirname, 'prompts/system_prompt.txt'), 'utf8'
);

// Два режима:
//  - сотрудник (channel/chatId есть в orch_employees) → EMPLOYEE CONTEXT (приём отчёта);
//  - иначе босс → обычный режим оркестрации.
async function getSystemPrompt(clientName, phone, channel, chatId) {
  const prompt = SYSTEM_PROMPT_RAW;

  const userContext = `

=== КОНТЕКСТ ПОЛЬЗОВАТЕЛЯ ===
Имя: ${clientName || 'не указано'}
Телефон: ${phone || 'не указан'}
Канал: ${channel || 'не указан'}
=== КОНЕЦ КОНТЕКСТА ===`;

  // Босс может быть в списке принудительно (даже если он же есть в реестре сотрудников).
  // phone — запасной идентификатор для LID-режима WhatsApp (chat_id может быть '...@lid').
  const chatDigits = String(chatId || '').replace(/\D/g, '');
  const phoneDigits = String(phone || '').replace(/\D/g, '');
  const forcedBoss = (chatDigits && config.BOSS_CONTACTS.includes(chatDigits))
    || (phoneDigits && config.BOSS_CONTACTS.includes(phoneDigits));

  let employeeContext = '';
  try {
    const emp = forcedBoss ? null
      : (await findEmployeeByContact(channel, chatId)
        || (phoneDigits ? await findEmployeeByContact(channel, phoneDigits) : null));
    if (emp) {
      const tasks = await getOpenTasksForEmployee(emp.id);
      const taskLines = tasks.length
        ? tasks.map((t) => `- task_id=${t.id} | "${t.title}" | статус: ${t.status} | приоритет: ${t.priority}`).join('\n')
        : '- (открытых задач нет)';
      employeeContext = `

=== EMPLOYEE CONTEXT ===
Это сообщение пришло от ЗАРЕГИСТРИРОВАННОГО СОТРУДНИКА. Ты — его связующее звено с руководством.
Логика:
- Если это статус по задаче (взял в работу / в процессе / готово / заблокировано / «пришёл» по
  задаче-отметке) — сопоставь с task_id ниже и вызови update_task (status: in_progress / blocked /
  done; при наличии — result). Ответь одной короткой строкой-подтверждением. Это же СНИМАЕТ
  контроль-сторож по задаче (он сам видит новый статус) — отдельно ничего делать не нужно.
- Если это ВОПРОС, ПРОБЛЕМА, ВОЗРАЖЕНИЕ или просьба, которую ты не можешь решить сам — вызови
  message_boss (передать руководителю), затем коротко скажи сотруднику, что передал. Простые
  уточнения по задаче можешь пояснить сам, не дёргая босса.
- ЛИЧНЫЕ просьбы сотрудника для СЕБЯ — выполняй сам (это его личные данные, у каждого свои):
  напоминание/будильник себе (manage_schedule), личная заметка (manage_notes), своя задача-памятка
  (manage_todos), веб-поиск (web_search), диаграмма (render_diagram), запомнить факт о нём
  (remember_fact). Пример: «напомни мне через час позвонить поставщику» → manage_schedule.
- БЕЗ ИЕРАРХИИ: у всех РАВНЫЕ права на бота, отличаются только ГРАНИЦЫ. Сотрудник тоже может
  ПОРУЧАТЬ и СПРАШИВАТЬ как босс: поставить задачу, план, делегировать, узнать статус
  (create_project / assign_task / dispatch_task / project_status / message_employee). Не отказывай
  «это только руководителю».
- ИНФОРМАЦИЯ О КОМПАНИИ И ШТАТЕ ОТКРЫТА ВСЕМ. «Кто директор/руководитель?», «что за компания?»,
  «список сотрудников / контакты / роли?», «какие планы?» — отвечай ПРЯМО (list_employees,
  project_status). НЕ говори «не разглашаю / внутреннее / только руководителю». Имя директора —
  из реестра (роль «Директор»), не выдумывай.
- ГРАНИЦЫ (что НЕ открыто): чужие ЛИЧНЫЕ данные другого человека (его личные заметки/напоминания/
  факты) не показывай; и только босс делает manage_employees (добавить/удалить штат) и
  performance_report (отчёты по всем) — если просит это, передай боссу через message_boss. Всё
  остальное доступно каждому.
Сотрудник: ${emp.name} (id=${emp.id}), роли: ${emp.roles}
Открытые задачи:
${taskLines}
=== КОНЕЦ EMPLOYEE CONTEXT ===`;
    }
  } catch (_) { /* lookup некритичен — без него работаем как с боссом */ }

  // Запомненные факты о пользователе (простая память) — подмешиваем в обоих режимах.
  let factsContext = '';
  try {
    const facts = await listFacts(channel, chatId, 50);
    if (facts.length) {
      const lines = facts.map((f) => `- ${f.fact}${f.category ? ` [${f.category}]` : ''}`).join('\n');
      factsContext = `

=== ЗАПОМНЕННЫЕ ФАКТЫ О ПОЛЬЗОВАТЕЛЕ ===
Учитывай это в ответах. Если факт устарел — обнови (forget_fact + remember_fact).
${lines}
=== КОНЕЦ ФАКТОВ ===`;
    }
  } catch (_) { /* память некритична */ }

  return prompt + userContext + employeeContext + factsContext;
}

module.exports = { getSystemPrompt };

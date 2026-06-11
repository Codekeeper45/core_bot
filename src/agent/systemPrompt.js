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
- Если это статус по задаче (взял в работу / в процессе / готово / заблокировано) — сопоставь с
  task_id ниже и вызови update_task (status: in_progress / blocked / done; при наличии — result).
  Ответь одной короткой строкой-подтверждением.
- Если это ВОПРОС, ПРОБЛЕМА, ВОЗРАЖЕНИЕ или просьба, которую ты не можешь решить сам — вызови
  message_boss (передать руководителю), затем коротко скажи сотруднику, что передал. Простые
  уточнения по задаче можешь пояснить сам, не дёргая босса.
- Не запускай новые планы, не управляй штатом.
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

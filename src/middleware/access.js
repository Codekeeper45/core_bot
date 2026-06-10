'use strict';
// Фильтр доступа: бот обслуживает ТОЛЬКО своих — сотрудников (есть в orch_employees)
// и боссов (номер/chat_id в BOSS_CONTACTS). Все прочие игнорируются.
// phone — запасной идентификатор: в LID-режиме WhatsApp chat_id может быть '...@lid'
// (внутренний id), а реальный номер приходит отдельно (normalize кладёт его в n.phone).
const config = require('../config');
const { findEmployeeByContact } = require('../services/mysql');

async function isAllowedSender(channel, chatId, phone) {
  const chatDigits = String(chatId || '').replace(/\D/g, '');
  const phoneDigits = String(phone || '').replace(/\D/g, '');

  if ((chatDigits && config.BOSS_CONTACTS.includes(chatDigits))
    || (phoneDigits && config.BOSS_CONTACTS.includes(phoneDigits))) {
    return { allowed: true, role: 'boss' };
  }

  // findEmployeeByContact возвращает null при отсутствии/сбое (не бросает).
  const emp = await findEmployeeByContact(channel, chatId)
    || (phoneDigits ? await findEmployeeByContact(channel, phoneDigits) : null);
  if (emp) return { allowed: true, role: 'employee' };

  return { allowed: false, role: null };
}

module.exports = { isAllowedSender };

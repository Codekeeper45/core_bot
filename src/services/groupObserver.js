'use strict';

const config = require('../config');

// Name-based matching is only a convenience fallback. In production, prefer
// GROUP_REPORT_REQUESTERS_WA because a WhatsApp display name is not identity.
const dynamicGroups = new Map(); // normalized subject -> JID, process-local

function normalizeName(value) {
  return String(value || '').toLocaleLowerCase('ru-RU').replace(/\s+/g, ' ').trim();
}

function digits(value) {
  return String(value || '').replace(/\D/g, '');
}

function configuredGroupNames() {
  return config.OBSERVE_ONLY_GROUP_NAMES.map(normalizeName).filter(Boolean);
}

function isObservedGroup({ chatId, subject } = {}) {
  const jid = String(chatId || '').trim();
  if (!jid || !jid.endsWith('@g.us')) return false;
  if (config.OBSERVE_ONLY_GROUP_WA.includes(jid)) return true;
  const normalizedSubject = normalizeName(subject);
  return !!normalizedSubject && configuredGroupNames().includes(normalizedSubject);
}

function rememberObservedGroup({ chatId, subject } = {}) {
  if (!isObservedGroup({ chatId, subject })) return false;
  const normalizedSubject = normalizeName(subject);
  if (normalizedSubject) dynamicGroups.set(normalizedSubject, String(chatId));
  return true;
}

function getObservedGroupIds() {
  const ids = new Set(config.OBSERVE_ONLY_GROUP_WA);
  for (const jid of dynamicGroups.values()) ids.add(jid);
  return [...ids];
}

function isObservedGroupId(chatId) {
  return getObservedGroupIds().includes(String(chatId || '').trim());
}

function isReportRequester(context = {}) {
  // Руководитель уже аутентифицирован через BOSS_CONTACTS в access middleware.
  // Не требуем для него отдельного имени/номера в настройке отчёта.
  if (context.role === 'boss') return true;

  const allowedNumbers = config.GROUP_REPORT_REQUESTERS_WA;
  const contextNumbers = [digits(context.chatId), digits(context.phone)].filter(Boolean);
  if (allowedNumbers.some((number) => contextNumbers.includes(number))) return true;

  const allowedNames = config.GROUP_REPORT_REQUESTER_NAMES.map(normalizeName).filter(Boolean);
  const contextNames = [context.clientName, context.employeeName].map(normalizeName).filter(Boolean);
  return allowedNames.some((name) => contextNames.includes(name));
}

function _clearDynamicGroups() {
  dynamicGroups.clear();
}

module.exports = {
  isObservedGroup,
  rememberObservedGroup,
  getObservedGroupIds,
  isObservedGroupId,
  isReportRequester,
  normalizeName,
  _clearDynamicGroups,
};

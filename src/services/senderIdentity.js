'use strict';
// Подпись отправителя для исходящих «от имени человека» (message_employee,
// forward_message): получатель видит, ОТ КОГО пришло — краткой подписью «имя
// (роль)», без номера телефона и канала, чтобы не мешать. Подпись попадает и в
// записанную историю (record:true) — то есть в контекст бота. Имя берём из
// реестра сотрудников (по контакту), роль «руководитель» — из BOSS_CONTACTS;
// фолбэк — имя из мессенджера.
const config = require('../config');

const CHANNEL_LABEL = { whatsapp: 'WhatsApp', telegram: 'Telegram', instagram: 'Instagram' };

// Интерактивные «скажи/перешли» идут от имени человека. Автоматические
// расписания и ежедневные ритуалы — от самого бота, без подписи владельца.
function shouldSignOutbound(context = {}) {
  return context.messageOrigin !== 'scheduled';
}

function digitsOf(v) { return String(v || '').replace(/\D/g, ''); }

// Человекочитаемый контакт отправителя: телефон → +7…, IG — @username, TG — @username/id.
function contactLabel(context) {
  const digits = digitsOf(context.chatId) || digitsOf(context.phone);
  if (context.channel === 'instagram') return context.chatId ? `@${String(context.chatId).replace(/^@/, '')}` : '';
  if (context.channel === 'telegram') {
    const p = String(context.phone || '');
    return p.startsWith('@') ? p : (digits ? `id ${digits}` : '');
  }
  return digits ? `+${digits}` : '';
}

// → { name, role, contact, channel, line } ; line — готовая строка подписи.
async function senderSignature(context = {}) {
  const digits = digitsOf(context.chatId) || digitsOf(context.phone);
  const isBoss = context.role === 'boss'
    || (digits && config.BOSS_CONTACTS.includes(digits));

  let emp = null;
  try {
    const { findEmployeeByContact } = require('./mysql');
    emp = await findEmployeeByContact(context.channel, context.chatId)
      || (digits ? await findEmployeeByContact(context.channel, digits) : null);
  } catch (_) { /* реестр недоступен — подпишем тем, что есть в контексте */ }

  const name = (emp && emp.name) || context.clientName || 'неизвестный отправитель';
  const role = isBoss ? 'руководитель' : ((emp && emp.roles) || null);
  const contact = contactLabel(context);
  const channel = CHANNEL_LABEL[String(context.channel || '').toLowerCase()] || '';

  // Подпись намеренно краткая: только имя (и роль, если известна) — без канала и
  // номера телефона, чтобы не засорять сообщение получателю.
  const line = `📨 От: ${name}${role ? ` (${role})` : ''}`;
  return { name, role, contact, channel, line };
}

module.exports = { senderSignature, shouldSignOutbound };

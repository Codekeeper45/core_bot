'use strict';
// Централизованная исходящая отправка в любой канал + проактивные уведомления боссу.
// Используется инструментами (dispatch_task, update_task, message_boss, message_employee)
// для сообщений в чаты, которые сейчас не активны (сотрудник ↔ босс).
const { getProject } = require('./mysql');
const config = require('../config');

// Доставить текст и/или медиа в указанный чат канала.
// media = { kind:'image'|'voice'|'document', buffer, caption?, fileName?, mimetype? } — опционально.
// Instagram (Wazzup) медиа не поддерживает → шлём текст/подпись (graceful fallback).
async function deliver(channel, contact, text, media = null) {
  const ch = String(channel || '').toLowerCase();
  if (!contact || (!text && !media)) return false;
  try {
    if (ch === 'telegram') {
      const tg = require('../channels/telegram');
      if (media && media.kind === 'image') await tg.sendPhoto(String(contact), media.buffer, media.caption || text || '');
      else if (media && media.kind === 'voice') { if (text) await tg.sendMessage(String(contact), text); await tg.sendVoice(String(contact), media.buffer); }
      else if (media && media.kind === 'document') { if (text) await tg.sendMessage(String(contact), text); await tg.sendDocument(String(contact), media.buffer, media.fileName); }
      else await tg.sendMessage(String(contact), text);
    } else if (ch === 'whatsapp') {
      const jid = String(contact).includes('@') ? contact : `${String(contact).replace(/\D/g, '')}@s.whatsapp.net`;
      const wa = require('../services/baileys');
      if (media && media.kind === 'image') await wa.sendImage(jid, media.buffer, media.caption || text || '');
      else if (media && media.kind === 'voice') { if (text) await wa.sendMessage(jid, text); await wa.sendVoice(jid, media.buffer); }
      else if (media && media.kind === 'document') { if (text) await wa.sendMessage(jid, text); await wa.sendDocument(jid, media.buffer, media.fileName, media.mimetype); }
      else await wa.sendMessage(jid, text);
    } else if (ch === 'instagram') {
      // Wazzup IG: только текст. Медиа недоступно — шлём подпись/текст честно.
      await require('../channels/instagram').sendMessage(String(contact), text || (media && media.caption) || '[медиа недоступно в Instagram]');
    } else {
      return false;
    }
    return true;
  } catch (err) {
    console.error(`[Notifier] deliver ${ch}:${contact} failed:`, err.message);
    return false;
  }
}

// Уведомить владельца (босса) проекта. exceptChatId — не слать, если инициатор
// сам босс в том же чате (чтобы не дублировать его собственное действие).
async function notifyOwner(projectId, text, exceptChatId) {
  try {
    const project = await getProject(projectId);
    if (!project || !project.owner_chat_id) return false;
    if (exceptChatId && String(project.owner_chat_id) === String(exceptChatId)) return false;
    return await deliver(project.owner_channel, project.owner_chat_id, text);
  } catch (err) {
    console.error('[Notifier] notifyOwner:', err.message);
    return false;
  }
}

// Ops-оповещение «живого» оператора при сбое ИИ (все LLM-провайдеры легли).
// Шлёт в заданные MANAGER_* контакты; если ничего не задано — тихий no-op.
async function alertManager(text) {
  let sent = false;
  try {
    if (config.MANAGER_TG) sent = (await deliver('telegram', config.MANAGER_TG, text)) || sent;
    const waTarget = config.MANAGER_GROUP_WA
      || (config.MANAGER_WA ? `${config.MANAGER_WA.replace(/\D/g, '')}@s.whatsapp.net` : '');
    if (waTarget) sent = (await deliver('whatsapp', waTarget, text)) || sent;
  } catch (err) {
    console.error('[Notifier] alertManager:', err.message);
  }
  return sent;
}

module.exports = { deliver, notifyOwner, alertManager };

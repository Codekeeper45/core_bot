'use strict';
// Централизованная исходящая отправка в любой канал + проактивные уведомления боссу.
// Используется инструментами (dispatch_task, update_task, message_boss, message_employee)
// для сообщений в чаты, которые сейчас не активны (сотрудник ↔ босс).
const { getProject } = require('./mysql');
const config = require('../config');

// Короткое описание медиа для записи в историю, когда текста нет (пересылка файла/фото).
function describeMedia(media) {
  if (!media) return '';
  if (media.kind === 'image') return '[фото]';
  if (media.kind === 'document') return `[файл: ${media.fileName || 'документ'}]`;
  if (media.kind === 'voice') return '[голосовое]';
  return '[вложение]';
}

// Доставить текст и/или медиа в указанный чат канала.
// media = { kind:'image'|'voice'|'document', buffer, caption?, fileName?, mimetype? } — опционально.
// Instagram (Wazzup) медиа не поддерживает → шлём текст/подпись (graceful fallback).
// opts.record=true — записать это исходящее в историю получателя (чтобы бот «помнил»,
// что сам отправил/переслал сотруднику). По умолчанию НЕ пишем (ops-алерты/группы/эхо).
async function deliver(channel, contact, text, media = null, opts = {}) {
  const ch = String(channel || '').toLowerCase();
  if (!contact || (!text && !media)) return false;
  // Адрес доставки = ключ истории получателя (для WA это JID, под ним же лежит входящая
  // переписка сотрудника — см. normalize chat_id). Считаем один раз: и для отправки, и для записи.
  const waJid = ch === 'whatsapp'
    ? (String(contact).includes('@') ? String(contact) : `${String(contact).replace(/\D/g, '')}@s.whatsapp.net`)
    : null;
  const recordKey = waJid || String(contact);
  try {
    let delivered;
    if (ch === 'telegram') {
      const tg = require('../channels/telegram');
      if (media && media.kind === 'image') delivered = await tg.sendPhoto(String(contact), media.buffer, media.caption || text || '');
      else if (media && media.kind === 'voice') {
        const textOk = text ? await tg.sendMessage(String(contact), text) : true;
        delivered = textOk && await tg.sendVoice(String(contact), media.buffer);
      } else if (media && media.kind === 'document') {
        const textOk = text ? await tg.sendMessage(String(contact), text) : true;
        delivered = textOk && await tg.sendDocument(String(contact), media.buffer, media.fileName);
      } else delivered = await tg.sendMessage(String(contact), text);
    } else if (ch === 'whatsapp') {
      const jid = waJid;
      const wa = require('../services/baileys');
      if (media && media.kind === 'image') delivered = await wa.sendImage(jid, media.buffer, media.caption || text || '');
      else if (media && media.kind === 'voice') {
        const textOk = text ? await wa.sendMessage(jid, text) : true;
        delivered = textOk && await wa.sendVoice(jid, media.buffer);
      } else if (media && media.kind === 'document') {
        const textOk = text ? await wa.sendMessage(jid, text) : true;
        delivered = textOk && await wa.sendDocument(jid, media.buffer, media.fileName, media.mimetype);
      } else delivered = await wa.sendMessage(jid, text);
    } else if (ch === 'instagram') {
      // Wazzup IG: только текст. Медиа недоступно — шлём подпись/текст честно.
      delivered = await require('../channels/instagram').sendMessage(String(contact), text || (media && media.caption) || '[медиа недоступно в Instagram]');
    } else {
      return false;
    }
    if (delivered === false) return false;
    // Доставлено — при необходимости фиксируем в истории получателя.
    if (opts && opts.record) {
      const body = (text && String(text).trim()) ? String(text) : describeMedia(media);
      if (body) {
        try {
          await require('../agent/memory').recordOutbound(ch, recordKey, body);
        } catch (recErr) { console.error('[Notifier] record outbound:', recErr.message); }
      }
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

// Уведомить босса, что НЕ-босс изменил общий ресурс (чужую задачу, план, реестр
// сотрудников, общефирменные рассылки). Философия «прозрачность вместо запретов»:
// действия не блокируются, но босс всегда в курсе. Роутинг как в message_boss
// (без owner-ветки): findBossRoute() → BOSS_CONTACTS → MANAGER_TG/MANAGER_WA.
// opts.projectId — владелец плана уже уведомлён notifyOwner: его chat_id скипаем,
// чтобы не дублировать. Действия самого босса не уведомляются. Fire-and-forget:
// на вызывающей стороне всегда .catch(() => {}) — сбой уведомления не валит инструмент.
async function notifyBossAboutChange(context = {}, text, opts = {}) {
  if (!text) return false;
  if (context.role === 'boss') return false;
  const actorDigits = new Set(
    [context.chatId, context.phone]
      .map((v) => String(v || '').replace(/\D/g, ''))
      .filter(Boolean)
  );
  const skipContacts = new Set();
  if (opts.projectId != null) {
    try {
      const project = await getProject(opts.projectId);
      if (project && project.owner_chat_id) skipContacts.add(String(project.owner_chat_id));
    } catch (_) { /* не смогли достать проект — просто не дедупим */ }
  }

  const routes = [];
  try {
    const { findBossRoute } = require('./mysql');
    const boss = await findBossRoute();
    if (boss) routes.push({ channel: boss.channel, contact: boss.contact });
  } catch (_) { /* реестр недоступен — идём по env-контактам */ }
  for (const d of config.BOSS_CONTACTS) routes.push({ channel: 'whatsapp', contact: d });
  if (config.MANAGER_TG) routes.push({ channel: 'telegram', contact: config.MANAGER_TG });
  if (config.MANAGER_WA) routes.push({ channel: 'whatsapp', contact: config.MANAGER_WA });

  for (const r of routes) {
    const digits = String(r.contact || '').replace(/\D/g, '');
    if (digits && actorDigits.has(digits)) continue;          // не уведомляем актёра о нём самом
    if (skipContacts.has(String(r.contact))) continue;        // владелец уже получил notifyOwner
    if (await deliver(r.channel, r.contact, text)) return true;
  }
  return false;
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

module.exports = { deliver, notifyOwner, alertManager, notifyBossAboutChange };

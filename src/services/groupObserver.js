'use strict';

const config = require('../config');
const { downloadVoice, transcribeVoiceBuffer, FALLBACK_VOICE } = require('../media/voice');
const { describeImage } = require('../media/image');
const { storeObservedGroupAudio, saveObservedGroupAudioTranscript } = require('./mysql');

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
  if (config.OBSERVE_ALL_GROUPS) return true;
  if (config.OBSERVE_ONLY_GROUP_WA.includes(jid)) return true;
  const normalizedSubject = normalizeName(subject);
  return !!normalizedSubject && configuredGroupNames().includes(normalizedSubject);
}

function rememberObservedGroup({ chatId, subject } = {}) {
  const jid = String(chatId || '').trim();
  if (!jid || !jid.endsWith('@g.us')) return false;
  // В режиме OBSERVE_ALL_GROUPS запоминаем все группы с названием
  if (config.OBSERVE_ALL_GROUPS) {
    const key = normalizeName(subject) || jid;
    dynamicGroups.set(key, jid);
    return true;
  }
  if (!isObservedGroup({ chatId: jid, subject })) return false;
  const normalizedSubject = normalizeName(subject);
  if (normalizedSubject) dynamicGroups.set(normalizedSubject, jid);
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

function findObservedGroupId(targetGroup) {
  if (!targetGroup) return null;
  const str = String(targetGroup).trim();
  if (str.endsWith('@g.us')) return str;
  const norm = normalizeName(str);
  for (const [subj, jid] of dynamicGroups.entries()) {
    if (subj.includes(norm) || norm.includes(subj)) return jid;
  }
  return null;
}

function getObservedGroupsInfo() {
  const result = [];
  const seen = new Set();
  for (const [subj, jid] of dynamicGroups.entries()) {
    if (!seen.has(jid)) {
      seen.add(jid);
      result.push({ id: jid, name: subj });
    }
  }
  for (const jid of config.OBSERVE_ONLY_GROUP_WA) {
    if (!seen.has(jid)) {
      seen.add(jid);
      result.push({ id: jid, name: jid });
    }
  }
  return result;
}

function detectCommitmentsAndDocuments(text) {
  const t = String(text || '').toLowerCase();
  const tags = [];
  if (/(обещал|приедет|загрузим|отгрузим|довезти|вышел|уехал|прибыл|к \d{1,2}:\d{2}|до \d{1,2}:\d{2})/i.test(t)) {
    tags.push('ОБЕЩАНИЕ/СРОК');
  }
  if (/(накладн|ттн|паллет|рейс|машин|водитель|авто|номер|казыбаев|покровк)/i.test(t)) {
    tags.push('НАКЛАДНАЯ/ДОКУМЕНТ');
  }
  return tags;
}

// The observed group bypasses the normal agent pipeline, so enrich media here
// before archiving it. This remains read-only: no reply is ever sent to the group.
async function observedMessageContent(message = {}) {
  const fallback = message.message_text_for_buffer || message.message || `[${message.message_type || 'сообщение'}]`;

  if (message.message_type === 'voice') {
    let downloaded;
    try {
      downloaded = await downloadVoice(message);
    } catch (err) {
      console.error('[Group observer] Voice download error:', err.message);
      return '[ГОЛОСОВОЕ]\nТранскрипцию получить не удалось.';
    }
    if (downloaded.buffer.length > config.OBSERVED_GROUP_AUDIO_MAX_BYTES) {
      console.warn(`[Group observer] Voice is too large to archive: ${downloaded.buffer.length} bytes`);
      return '[ГОЛОСОВОЕ]\nАудиофайл слишком большой для сохранения и транскрипции.';
    }
    let audioId = null;
    try {
      audioId = await storeObservedGroupAudio({
        channel: message.channel, chatId: message.chat_id, sourceMessageId: message.message_id,
        actorName: message.client_name, mimeType: downloaded.mimeType, buffer: downloaded.buffer,
      });
    } catch (err) {
      console.error('[Group observer] Voice storage error:', err.message);
    }
    const transcript = await transcribeVoiceBuffer(downloaded.buffer, downloaded.mimeType);
    if (!transcript || transcript === FALLBACK_VOICE) {
      return '[ГОЛОСОВОЕ]\nТранскрипцию получить не удалось. Оригинал сохранён: можно повторить расшифровку позже.';
    }
    if (audioId) {
      try { await saveObservedGroupAudioTranscript(audioId, transcript); } catch (err) {
        console.error('[Group observer] Transcript storage error:', err.message);
      }
    }
    const tags = detectCommitmentsAndDocuments(transcript);
    const tagHeader = tags.length ? ` [${tags.join(' | ')}]` : '';
    return `[ГОЛОСОВОЕ${tagHeader}]\nТранскрипция: ${transcript}`;
  }

  if (message.message_type === 'image') {
    const description = await describeImage({
      image_ref: message.image_source || message.image_url || '',
      caption: message.image_caption || '',
      baileys_media_obj: message.baileys_media_obj || null,
    }, message.channel);
    const combined = `${message.image_caption || ''} ${description}`;
    const tags = detectCommitmentsAndDocuments(combined);
    const tagHeader = tags.length ? ` [${tags.join(' | ')}]` : '';
    return `[ИЗОБРАЖЕНИЕ${tagHeader}]\nПодпись: ${message.image_caption || 'нет'}\nОписание: ${description}`;
  }

  return fallback;
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
  findObservedGroupId,
  getObservedGroupsInfo,
  observedMessageContent,
  isReportRequester,
  normalizeName,
  _clearDynamicGroups,
};

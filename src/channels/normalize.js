'use strict';
const config = require('../config');
const { normalizePhone } = require('../utils/helpers');
const { isObservedGroup, rememberObservedGroup } = require('../services/groupObserver');

const BLOCKED_PHONES = new Set(config.BLOCKED_PHONES.map(normalizePhone).filter(Boolean));
const EXCLUDED_CHAT_ID = config.EXCLUDED_CHAT_ID;

function getDocumentFamily(mimeType = '', fileName = '') {
  const mt = mimeType.toLowerCase();
  const ext = (fileName.split('.').pop() || '').toLowerCase();
  if (mt === 'application/pdf' || ext === 'pdf') return 'pdf';
  if (mt.includes('word') || mt.includes('officedocument.wordprocessing') || ['doc', 'docx'].includes(ext)) return 'doc';
  // Табличные форматы (xlsx читаются библиотекой xlsx как есть; ODS — тоже).
  if (mt.includes('opendocument.spreadsheet') || mt.includes('spreadsheet') || mt.includes('excel')
    || ['xls', 'xlsx', 'ods', 'ots'].includes(ext)) return 'spreadsheet';
  // Текстовые/структурные форматы — читаем как utf-8, годятся для базы знаний.
  if (mt === 'text/plain' || mt === 'text/csv' || mt === 'text/tab-separated-values'
    || mt.includes('json') || mt.includes('xml') || mt.includes('yaml') || mt.includes('markdown') || mt.includes('html')
    || ['txt', 'csv', 'tsv', 'md', 'markdown', 'json', 'xml', 'yaml', 'yml', 'log', 'ini', 'html', 'htm'].includes(ext)) return 'text';
  if (mt.includes('presentation') || mt.includes('powerpoint') || ['ppt', 'pptx'].includes(ext)) return 'presentation';
  return 'unsupported';
}

function normalizeInbound(raw) {
  const isBlocked = (phone) => BLOCKED_PHONES.has(normalizePhone(phone));
  let n = {
    channel: null, chat_id: null, phone: null, client_name: null,
    message: null, message_text_for_buffer: null, message_id: null,
    message_type: 'text', original_message_type: null,
    is_private: false, has_voice: false, has_image: false, has_document: false,
    is_observed_group: false, group_subject: null,
    voice_source_url: null, voice_file_id: null, voice_mime_type: null, voice_duration: null,
    image_source: null, image_url: null, image_caption: null,
    document_source_url: null, document_file_id: null, document_file_name: null,
    document_mime_type: null, document_extension: null, document_family: null,
    // Видео-подобные: video (обычное), video_note (кружок), animation (гифка), sticker.
    has_video: false, video_source_url: null, video_file_id: null,
    video_mime_type: null, video_duration: null,
    // Какой тип медиа скачивать у Baileys для видео-подобных (video|sticker|ptv).
    baileys_media_type: null,
    sticker_emoji: null, sticker_format: null, // webp | webm | tgs
    is_outgoing: false, is_self_message: false, is_supported: false, unsupported_reason: '',
    // Baileys-specific: carries the media sub-object for downloadMedia()
    baileys_raw_msg: null,
    baileys_media_obj: null,
    // Canned reply for "we received your sticker/geo/etc but can't process it" —
    // when set, index.js sends this text and skips the agent loop.
    unsupported_canned_message: null,
    // Wazzup-specific: original IG username (without @) and the upstream
    // message id used as crmMessageId for idempotent sends.
    ig_username: null,
    wazzup_message_id: null,
  };

  // ===== TELEGRAM =====
  if (raw.update_id !== undefined) {
    n.channel = 'telegram';
    const msg = raw.message || raw.edited_message;
    if (!msg) { n.unsupported_reason = 'no message'; return n; }

    n.message_id = String(msg.message_id || '');
    n.chat_id = String(msg.chat?.id || '');
    n.is_private = msg.chat?.type === 'private';
    const from = msg.from || {};
    n.client_name = [from.first_name, from.last_name].filter(Boolean).join(' ') || from.username || 'Неизвестно';
    n.phone = from.username ? `@${from.username}` : String(from.id || '');
    n.is_outgoing = from.is_bot === true;
    n.is_self_message = false;

    if (msg.text) {
      n.message_type = 'text';
      n.original_message_type = 'text';
      n.message = msg.text;
      n.message_text_for_buffer = msg.text;
    } else if (msg.voice || msg.audio) {
      const v = msg.voice || msg.audio;
      n.message_type = 'voice';
      n.original_message_type = msg.voice ? 'voice' : 'audio';
      n.has_voice = true;
      n.voice_file_id = v.file_id;
      n.voice_mime_type = v.mime_type || 'audio/ogg';
      n.voice_duration = String(v.duration || '');
      n.message = '';
      n.message_text_for_buffer = '[голосовое сообщение]';
    } else if (msg.photo) {
      const largest = msg.photo[msg.photo.length - 1];
      n.message_type = 'image';
      n.original_message_type = 'photo';
      n.has_image = true;
      n.image_source = `tg:${largest.file_id}`;
      n.image_caption = msg.caption || '';
      n.message = msg.caption || '';
      n.message_text_for_buffer = msg.caption || '[изображение]';
    } else if (msg.video || msg.video_note || msg.animation) {
      const v = msg.video || msg.video_note || msg.animation;
      n.message_type = msg.video_note ? 'video_note' : (msg.animation ? 'animation' : 'video');
      n.original_message_type = n.message_type;
      n.has_video = true;
      n.video_file_id = v.file_id;
      n.video_mime_type = v.mime_type || 'video/mp4';
      n.video_duration = String(v.duration || '');
      n.image_caption = msg.caption || '';
      n.message = msg.caption || '';
      n.message_text_for_buffer = msg.caption
        || (n.message_type === 'video_note' ? '[видеокружок]' : (n.message_type === 'animation' ? '[гифка]' : '[видео]'));
    } else if (msg.sticker) {
      const st = msg.sticker;
      n.message_type = 'sticker';
      n.original_message_type = 'sticker';
      n.video_file_id = st.file_id; // скачивается тем же путём, что видео
      n.sticker_emoji = st.emoji || null;
      n.sticker_format = st.is_animated ? 'tgs' : (st.is_video ? 'webm' : 'webp');
      n.message = '';
      n.message_text_for_buffer = `[стикер${st.emoji ? ` ${st.emoji}` : ''}]`;
    } else if (msg.document) {
      const doc = msg.document;
      const mimeType = doc.mime_type || '';
      if (mimeType.startsWith('image/')) {
        n.message_type = 'image';
        n.original_message_type = 'document_image';
        n.has_image = true;
        n.image_source = `tg:${doc.file_id}`;
        n.image_caption = msg.caption || '';
        n.message = msg.caption || '';
        n.message_text_for_buffer = msg.caption || '[изображение]';
      } else if (mimeType.startsWith('video/')) {
        n.message_type = 'video';
        n.original_message_type = 'document_video';
        n.has_video = true;
        n.video_file_id = doc.file_id;
        n.video_mime_type = mimeType;
        n.message = msg.caption || '';
        n.message_text_for_buffer = msg.caption || '[видео]';
      } else {
        n.message_type = 'document';
        n.original_message_type = 'document';
        n.has_document = true;
        n.document_file_id = doc.file_id;
        n.document_file_name = doc.file_name || 'file';
        n.document_mime_type = mimeType;
        n.document_extension = (doc.file_name || '').split('.').pop().toLowerCase();
        n.document_family = getDocumentFamily(mimeType, doc.file_name || '');
        n.message = msg.caption || '';
        n.message_text_for_buffer = `[документ: ${doc.file_name || 'file'}]`;
      }
    } else {
      n.unsupported_reason = 'unsupported_message_type';
    }

    const blocked = BLOCKED_PHONES.has(normalizePhone(n.phone));
    const isExcluded = n.chat_id === EXCLUDED_CHAT_ID;
    n.is_supported = n.is_private && !n.is_outgoing && !blocked && !isExcluded && (n.message_type !== null) && !n.unsupported_reason;

  // ===== WHATSAPP (Baileys WebSocket) =====
  } else if (raw.__baileys) {
    n.channel = 'whatsapp';
    const msg = raw.baileysMsg;
    const jid = msg.key.remoteJid || '';
    // LID-режим новых Baileys: remoteJid может быть '...@lid' (внутренний id, НЕ телефон),
    // а классический телефонный JID лежит в remoteJidAlt. Для chat_id предпочитаем
    // телефонный JID — на нём держатся BOSS_CONTACTS, реестр сотрудников и история.
    const altJid = msg.key.remoteJidAlt || '';
    const phoneJid = jid.includes('@s.whatsapp.net') ? jid
      : (altJid.includes('@s.whatsapp.net') ? altJid : '');

    n.chat_id = phoneJid || jid;
    n.is_private = !jid.endsWith('@g.us');
    n.group_subject = msg.__groupSubject || null;
    n.is_outgoing = msg.key.fromMe === true;
    n.is_self_message = false;
    n.client_name = msg.pushName || 'Неизвестно';
    n.message_id = msg.key.id || '';
    n.baileys_raw_msg = msg;
    n.is_observed_group = !n.is_outgoing
      && isObservedGroup({ chatId: n.chat_id, subject: n.group_subject });
    if (n.is_observed_group) rememberObservedGroup({ chatId: n.chat_id, subject: n.group_subject });

    n.phone = (phoneJid || jid).replace(/@.*$/, '').replace(/\D/g, '');

    if (n.is_outgoing) {
      n.unsupported_reason = 'outgoing';
      return n;
    }

    const waMsg = msg.message || {};

    if (waMsg.conversation || waMsg.extendedTextMessage) {
      n.message_type = 'text';
      n.original_message_type = 'text';
      n.message = waMsg.conversation || waMsg.extendedTextMessage?.text || '';
      n.message_text_for_buffer = n.message;
    } else if (waMsg.audioMessage) {
      n.message_type = 'voice';
      n.original_message_type = waMsg.audioMessage.ptt ? 'ptt' : 'audio';
      n.has_voice = true;
      n.voice_mime_type = waMsg.audioMessage.mimetype || 'audio/ogg; codecs=opus';
      n.voice_duration = String(waMsg.audioMessage.seconds || '');
      n.baileys_media_obj = waMsg.audioMessage;
      n.message = '';
      n.message_text_for_buffer = '[голосовое сообщение]';
    } else if (waMsg.imageMessage) {
      n.message_type = 'image';
      n.original_message_type = 'image';
      n.has_image = true;
      n.image_source = 'wa-baileys';
      n.image_caption = waMsg.imageMessage.caption || '';
      n.baileys_media_obj = waMsg.imageMessage;
      n.message = n.image_caption;
      n.message_text_for_buffer = n.image_caption || '[изображение]';
    } else if (waMsg.videoMessage || waMsg.ptvMessage) {
      // ptvMessage — видеокружок WhatsApp (push-to-video); gifPlayback — гифка.
      const v = waMsg.videoMessage || waMsg.ptvMessage;
      n.message_type = waMsg.ptvMessage ? 'video_note' : (v.gifPlayback ? 'animation' : 'video');
      n.original_message_type = n.message_type;
      n.has_video = true;
      n.video_mime_type = v.mimetype || 'video/mp4';
      n.video_duration = String(v.seconds || '');
      n.baileys_media_obj = v;
      n.baileys_media_type = waMsg.ptvMessage ? 'ptv' : 'video';
      n.image_caption = v.caption || '';
      n.message = v.caption || '';
      n.message_text_for_buffer = v.caption
        || (n.message_type === 'video_note' ? '[видеокружок]' : (n.message_type === 'animation' ? '[гифка]' : '[видео]'));
    } else if (waMsg.stickerMessage) {
      const st = waMsg.stickerMessage;
      n.message_type = 'sticker';
      n.original_message_type = 'sticker';
      n.baileys_media_obj = st;
      n.baileys_media_type = 'sticker';
      n.sticker_format = 'webp'; // WA-стикеры (в т.ч. анимированные) — webp
      n.message = '';
      n.message_text_for_buffer = '[стикер]';
    } else if (waMsg.documentMessage) {
      const doc = waMsg.documentMessage;
      const mimeType = doc.mimetype || '';
      if (mimeType.startsWith('image/')) {
        n.message_type = 'image';
        n.original_message_type = 'document_image';
        n.has_image = true;
        n.image_source = 'wa-baileys';
        n.image_caption = doc.caption || '';
        n.baileys_media_obj = doc;
        n.message = n.image_caption;
        n.message_text_for_buffer = n.image_caption || '[изображение]';
      } else if (mimeType.startsWith('video/')) {
        n.message_type = 'video';
        n.original_message_type = 'document_video';
        n.has_video = true;
        n.video_mime_type = mimeType;
        n.baileys_media_obj = doc;
        n.baileys_media_type = 'document';
        n.message = doc.caption || '';
        n.message_text_for_buffer = doc.caption || '[видео]';
      } else {
        n.message_type = 'document';
        n.original_message_type = 'document';
        n.has_document = true;
        n.document_file_name = doc.fileName || 'file';
        n.document_mime_type = mimeType;
        n.document_extension = (doc.fileName || '').split('.').pop().toLowerCase();
        n.document_family = getDocumentFamily(mimeType, doc.fileName || '');
        n.baileys_media_obj = doc;
        n.message = doc.caption || '';
        n.message_text_for_buffer = `[документ: ${doc.fileName || 'file'}]`;
      }
    } else {
      n.unsupported_reason = `unsupported_baileys_type`;
    }

    const blocked = BLOCKED_PHONES.has(normalizePhone(n.phone));
    const isExcluded = n.chat_id === EXCLUDED_CHAT_ID;
    n.is_supported = (n.is_private || n.is_observed_group) && !n.is_outgoing
      && !blocked && !isExcluded && !n.unsupported_reason;
    if (blocked) n.unsupported_reason = 'blocked';
    if (isExcluded) n.unsupported_reason = 'excluded_chat';

  // ===== INSTAGRAM (Wazzup24 webhook) =====
  // Каждый POST от Wazzup приходит как { messages: [...] }; index.js
  // разворачивает массив и зовёт normalizeInbound по одному сообщению с
  // флагом __wazzup: true. Транспорт может быть 'instagram', 'whatsapp',
  // 'telegram' и т.д. — мы маршрутизируем только IG (остальные транспорты
  // у нас уже идут напрямую через Baileys/Telegraf).
  } else if (raw.__wazzup) {
    const w = raw.wazzupMsg || {};
    const transport = String(w.chatType || '').toLowerCase();
    if (transport !== 'instagram') {
      n.unsupported_reason = `wazzup_transport_not_handled:${transport}`;
      return n;
    }

    n.channel = 'instagram';
    n.wazzup_message_id = w.messageId || '';
    n.message_id = w.messageId || '';
    n.ig_username = w.chatId || '';       // IG username без @
    n.chat_id = w.chatId || '';
    n.client_name = w.contact?.name || w.chatId || 'Неизвестно';
    // В IG у нас нет номера телефона — гейт-вопрос «оставьте телефон» бот
    // задаст в диалоге. phone остаётся пустым, идентифицируем лида по chat_id.
    n.phone = '';
    n.is_private = true;                  // IG DM всегда приватный
    n.is_outgoing = w.isEcho === true;    // сообщение из Wazzup iframe / SDK
    n.is_self_message = false;

    if (n.is_outgoing) {
      // Менеджер ответил руками через Wazzup iframe — это эхо, игнорируем.
      n.unsupported_reason = 'outgoing_isecho';
      return n;
    }

    const type = String(w.type || 'text').toLowerCase();
    const contentUri = w.contentUri || '';
    const text = w.text || '';

    if (type === 'text') {
      n.message_type = 'text';
      n.original_message_type = 'text';
      n.message = text;
      n.message_text_for_buffer = text;
    } else if (type === 'image') {
      n.message_type = 'image';
      n.original_message_type = 'image';
      n.has_image = true;
      // image_source — URL: analyzeImages в src/media/image.js видит, что
      // префикс не 'tg:' и не 'wa-baileys', и идёт по ветке analyzeImageUrl.
      n.image_source = contentUri;
      n.image_url = contentUri;
      n.image_caption = text;
      n.message = text;
      n.message_text_for_buffer = text || '[изображение]';
    } else if (type === 'audio') {
      n.message_type = 'voice';
      n.original_message_type = 'audio';
      n.has_voice = true;
      n.voice_source_url = contentUri;
      n.voice_mime_type = 'audio/ogg';   // Wazzup webhook не отдаёт mime — STT всё равно угадает по байтам
      n.message = '';
      n.message_text_for_buffer = '[голосовое сообщение]';
    } else if (type === 'document') {
      n.message_type = 'document';
      n.original_message_type = 'document';
      n.has_document = true;
      n.document_source_url = contentUri;
      // Wazzup webhook не даёт filename/mime — пытаемся вытянуть из URL.
      const urlPath = (() => { try { return new URL(contentUri).pathname; } catch { return contentUri; } })();
      const fileName = urlPath.split('/').pop() || 'file';
      n.document_file_name = fileName;
      n.document_extension = (fileName.split('.').pop() || '').toLowerCase();
      n.document_mime_type = '';
      n.document_family = getDocumentFamily('', fileName);
      n.message = text;
      n.message_text_for_buffer = `[документ: ${fileName}]`;
    } else if (type === 'video') {
      n.message_type = 'video';
      n.original_message_type = 'video';
      n.has_video = true;
      n.video_source_url = contentUri;
      n.video_mime_type = 'video/mp4'; // Wazzup mime не отдаёт — IG-видео это mp4
      n.message = text;
      n.message_text_for_buffer = text || '[видео]';
    } else if (['vcard', 'geo', 'unsupported', 'missing_call', 'unknown', 'wapi_template'].includes(type)) {
      // Эти типы Instagram у нас не разбираются (нет парсера для vCard и т.д.).
      // Отвечаем заглушкой, чтобы клиент не подумал что мы его игнорируем.
      const map = {
        vcard: 'Визитку я открыть не могу.',
        geo: 'Геолокацию я не использую.',
        missing_call: 'Я не могу принимать звонки.',
        unsupported: 'Этот формат я не разбираю.',
        unknown: 'Я не понял тип сообщения.',
        wapi_template: 'Шаблонные сообщения я не обрабатываю.',
      };
      n.unsupported_canned_message = `${map[type] || 'Этот формат я не разбираю.'} Пожалуйста, напишите текстом — или отправьте фото / видео / голосовое, я их понимаю.`;
      n.unsupported_reason = `ig_type_${type}`;
    } else {
      n.unsupported_canned_message = 'Этот формат сообщений я пока не обрабатываю. Напишите, пожалуйста, текстом — или отправьте фото / голосовое.';
      n.unsupported_reason = `ig_type_unknown:${type}`;
    }

    const isExcluded = n.chat_id === EXCLUDED_CHAT_ID;
    // Для IG BLOCKED_PHONES не применяем — там не телефоны, а usernames.
    n.is_supported = !n.is_outgoing && !isExcluded && !n.unsupported_reason && !!n.message_type;
    if (isExcluded) n.unsupported_reason = 'excluded_chat';

  } else {
    // Unknown format
    n.unsupported_reason = 'unknown_channel';
  }

  return n;
}

module.exports = { normalizeInbound, getDocumentFamily };

'use strict';
// Пересылка присланного (фото / файл / голос / текст) сотруднику из штата.
// Доступен ВСЕМ (не в BOSS_ONLY). Пересылается медиа ТЕКУЩЕГО сообщения: ссылки на него
// доходят сюда через context.incomingMedia (см. index.js → runAgent), а сам файл повторно
// скачивается в момент пересылки (media/incomingMedia.js) и шлётся как реальный файл.
const { findEmployees } = require('../services/mysql');
const notifier = require('../services/notifier');
const { downloadIncoming } = require('../media/incomingMedia');
const { handleToolDbError } = require('../utils/toolError');

const definition = {
  type: 'function',
  function: {
    name: 'forward_message',
    description:
      'Переслать сотруднику то, что прислали В ТЕКУЩЕМ сообщении: фото, файл/документ, голосовое '
      + 'и/или текст — реальными вложениями, не описанием. Доступно ВСЕМ (и боссу, и сотруднику). '
      + 'Используй, когда просят «передай это Ивану», «скинь файл бухгалтеру», «перешли фото на склад». '
      + 'Адресат to: id / имя / роль из штата. to_all=true — переслать всем по роли. message — '
      + 'необязательный комментарий к пересылке. Пересылается ровно то, что пришло сейчас; '
      + 'в Instagram вложения уходят текстом (ограничение канала). Получатель — только из штата.',
    parameters: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'Кому переслать: id / имя / роль сотрудника (напр. «бухгалтер», «Иван», «5»).' },
        message: { type: 'string', description: 'Необязательный сопроводительный текст/комментарий к пересылаемому.' },
        to_all: { type: 'boolean', description: 'true = переслать ВСЕМ подходящим по роли. По умолчанию одному.' },
      },
      required: ['to'],
    },
  },
};

async function handler(args, context = {}) {
  try {
    const to = String(args.to || '').trim();
    if (!to) return { success: false, message: 'Укажи to — кому переслать (имя/роль/id из штата).' };

    const matches = await findEmployees(to);
    const recipients = matches.filter((m) => m.contact);
    if (!recipients.length) {
      return { success: false, reason: 'no_recipient', message: `Не нашёл в штате получателя с контактом по запросу «${to}».` };
    }

    const media = Array.isArray(context.incomingMedia) ? context.incomingMedia : [];
    const text = String(args.message || '').trim();
    if (!media.length && !text) {
      return { success: false, message: 'Нечего пересылать — во входящем сообщении нет вложений, и текст не задан.' };
    }

    // Предзагрузка медиа ОДИН раз (для to_all не качаем по разу на каждого).
    const loaded = [];
    const failed_media = [];
    for (const item of media) {
      try {
        const got = await downloadIncoming(item);
        loaded.push({ type: item.type, buffer: got.buffer, fileName: item.file_name || got.fileName, mimetype: item.mime || got.mime });
      } catch (e) {
        failed_media.push({ type: item.type, error: e.message });
      }
    }

    const targets = args.to_all ? recipients : [recipients[0]];
    const sent_to = [];
    let igDropped = false;
    for (const r of targets) {
      const ch = r.channel || 'whatsapp';
      let okAny = false;
      if (text) okAny = (await notifier.deliver(ch, r.contact, text)) || okAny;
      for (const m of loaded) {
        const ok = await notifier.deliver(ch, r.contact, '', {
          kind: m.type, buffer: m.buffer, caption: '', fileName: m.fileName, mimetype: m.mimetype,
        });
        okAny = ok || okAny;
        if (ch === 'instagram') igDropped = true;
      }
      sent_to.push({ id: r.id, name: r.name, channel: ch, sent: okAny });
    }

    const forwarded = {
      images: loaded.filter((m) => m.type === 'image').length,
      documents: loaded.filter((m) => m.type === 'document').length,
      voice: loaded.filter((m) => m.type === 'voice').length,
      text: text ? 1 : 0,
    };
    const okCount = sent_to.filter((s) => s.sent).length;
    const notes = [];
    if (failed_media.length) notes.push(`не удалось скачать ${failed_media.length} вложение(й)`);
    if (igDropped) notes.push('часть получателей в Instagram — вложения ушли текстом');

    return {
      success: okCount > 0,
      forwarded,
      count: okCount,
      total: targets.length,
      sent_to,
      failed_media: failed_media.length ? failed_media : undefined,
      note: notes.length ? notes.join('; ') : 'переслано',
    };
  } catch (err) {
    return handleToolDbError(err);
  }
}

module.exports = { definition, handler };

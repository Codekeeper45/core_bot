'use strict';
const { setHandoff } = require('../services/mysql');
const config = require('../config');
const { pickRealPhone } = require('../utils/helpers');

// ─── Tool definition (OpenAI function-calling schema) ───────────────────────
const definition = {
  type: 'function',
  function: {
    name: 'notify_manager',
    description: `Передаёт диалог живому менеджеру и ставит бота на паузу (handoff). Это инструмент, меняющий состояние — вызывай ТОЛЬКО в ответ на явный сигнал пользователя или ситуацию вне компетенции бота.

Когда вызывать:
- пользователь явно просит связать с человеком / менеджером / оператором;
- жалоба или конфликт, требующий участия человека;
- конкретное требование/запрос, который бот не может выполнить сам;
- вопрос вне зоны ответственности бота, требующий ручной обработки.

Чего делать НЕ надо:
- НЕ эскалируй на простое «да» / «окей» / «спасибо» вне явного запроса о человеке.
- НЕ эскалируй на эмоцию или лёгкое недовольство без конкретного требования — сначала уточни, что нужно пользователю.

После вызова верни пользователю ТОЛЬКО поле client_message из результата — ничего не добавляй от себя.`,
    parameters: {
      type: 'object',
      properties: {
        event_type: {
          type: 'string',
          enum: ['human_request', 'complaint', 'escalation'],
          description: 'Тип события: human_request=просьба о человеке, complaint=жалоба, escalation=иная эскалация',
        },
        summary: {
          type: 'string',
          description: 'Краткое описание запроса для менеджера: суть вопроса и контекст',
        },
        phone: {
          type: 'string',
          description: 'Номер телефона пользователя для связи (только цифры, без +). Если номер неизвестен — передай пустую строку.',
        },
      },
      required: ['event_type', 'summary'],
    },
  },
};

// ─── Tool handler (вызывается registry'ем) ──────────────────────────────────
// context = { channel, chatId, phone, clientName }
async function handler(args, context) {
  const { channel, chatId, phone, clientName } = context;
  const notifyPhone = pickRealPhone(args.phone, phone);
  return runNotifyManager({
    ...args,
    channel,
    client_name: clientName,
    phone: notifyPhone,
    chat_id: chatId,
  });
}

async function runNotifyManager(input) {
  try {
    const channel = String(input.channel || 'whatsapp').toLowerCase();
    const clientName = String(input.client_name || 'Неизвестно').trim();
    const phone = String(input.phone || '').replace(/\D/g, '');
    const chatId = String(input.chat_id || '').trim();
    const summary = String(input.summary || '').trim();
    const eventType = String(input.event_type || 'escalation').trim();
    const managerName = config.MANAGER_NAME || 'Менеджер';

    // Build contact link for manager
    let contactLine = '';
    let channelLine = `Канал: ${channel}`;
    if (channel === 'whatsapp' && phone) {
      contactLine = `Открыть чат: https://wa.me/${phone}`;
    } else if (channel === 'telegram' && chatId) {
      contactLine = `Telegram ID: ${chatId}${clientName ? ` (${clientName})` : ''}`;
    } else if (channel === 'instagram') {
      // chat_id для IG = username без @. У IG нет публичного wa.me-аналога;
      // direct.instagram.com/t/{ig_user_id} требует internal id, но
      // https://www.instagram.com/{username}/ всегда открывает профиль —
      // оттуда менеджер жмёт «Message». Сам диалог менеджер ведёт через
      // Wazzup-iframe.
      const igUsername = chatId;
      channelLine = `Канал: Instagram (@${igUsername})`;
      contactLine = `Профиль: https://www.instagram.com/${igUsername}/\nОтвечать через Wazzup iframe`;
    }

    const text = [
      `${config.BOT_NAME} — передача диалога`,
      `Тип: ${eventType}`,
      channelLine,
      `Клиент: ${clientName}`,
      phone ? `Телефон: +${phone}` : '',
      contactLine,
      summary ? `Запрос: ${summary}` : '',
      `Менеджер: ${managerName}`,
    ].filter(Boolean).join('\n');

    let sent = false;

    // Notify via WhatsApp (Baileys) — группа приоритетнее личного номера
    const waTarget = config.MANAGER_GROUP_WA || (config.MANAGER_WA ? `${config.MANAGER_WA.replace(/\D/g, '')}@s.whatsapp.net` : '');
    if (waTarget) {
      try {
        const baileys = require('../services/baileys');
        // Диагностика группы перед отправкой
        if (waTarget.endsWith('@g.us')) {
          try {
            const meta = await baileys.sock.groupMetadata(waTarget);
            const botJid = baileys.sock.user?.id || '';
            const self = meta.participants.find(p => p.id.startsWith(botJid.split(':')[0]));
            console.log(`[NotifyManager] Группа: announce=${meta.announce}, участников=${meta.participants.length}, бот=${self ? `участник(admin=${self.admin})` : 'НЕ найден'}`);
          } catch (e) {
            console.warn('[NotifyManager] Не удалось получить метаданные группы:', e.message);
          }
        }
        await baileys.sendMessage(waTarget, text);
        sent = true;
        console.log(`[NotifyManager] WA → ${waTarget}: OK`);
      } catch (err) {
        console.error('[NotifyManager] WA send error:', err.message, JSON.stringify(err.data || err.output || ''));
      }
    }

    // Notify via Telegram
    if (config.MANAGER_TG) {
      try {
        const tg = require('../channels/telegram');
        await tg.sendMessage(config.MANAGER_TG, text);
        sent = true;
        console.log(`[NotifyManager] TG → ${config.MANAGER_TG}: OK`);
      } catch (err) {
        console.error('[NotifyManager] TG send error:', err.message);
      }
    }

    // Activate handoff — bot pauses, manager takes over
    if (chatId) {
      await setHandoff(channel, chatId, { active: true, manager_name: managerName, channel, reason: eventType, started_at: new Date().toISOString() }, config.HANDOFF_TTL);
    }

    // Client-facing manager contact: explicit public contact, else a wa.me link
    // from MANAGER_WA. Lets the client reach the manager themselves if they want.
    const managerContact = config.MANAGER_PUBLIC_CONTACT
      || (config.MANAGER_WA ? `https://wa.me/${config.MANAGER_WA.replace(/\D/g, '')}` : '');
    const clientMessage = managerContact
      ? `Сейчас передам ваш вопрос нашему специалисту. Он свяжется с вами в течение 30 минут. Если хотите связаться сами — вот прямой контакт: ${managerContact}. Спасибо за терпение!`
      : `Сейчас передам ваш вопрос нашему специалисту. Он свяжется с вами в течение 30 минут. Спасибо за терпение!`;

    return {
      success: true,
      status: sent ? 'sent' : 'no_manager_contact_configured',
      manager_name: managerName,
      handoff_activated: !!chatId,
      client_message: clientMessage,
    };
  } catch (err) {
    console.error('[NotifyManager] Error:', err.message);
    return { success: false, status: 'error', manager_name: '', handoff_activated: false, client_message: '' };
  }
}

module.exports = { runNotifyManager, definition, handler };

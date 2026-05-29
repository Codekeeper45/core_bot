'use strict';
const { setHandoff } = require('../services/mysql');
const config = require('../config');
const { maskPhone, maskName } = require('../utils/piiMask');

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

module.exports = { runNotifyManager };

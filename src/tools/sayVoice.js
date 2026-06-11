'use strict';
// Озвучить ответ голосом по решению агента — с управлением интонацией.
// Текст здесь ОТДЕЛЁН от отображаемого ответа: теги [] и стиль-инструкции попадают только
// в голос и не показываются пользователю. Режим босса (BOSS_ONLY).
const { synthesizeSpeech } = require('../services/tts');
const notifier = require('../services/notifier');
const voiceFlag = require('../services/voiceFlag');

const definition = {
  type: 'function',
  function: {
    name: 'say_voice',
    description:
      'Отправить боссу ГОЛОСОВОЕ сообщение (озвучка через TTS). Используй, когда уместно ответить '
      + 'голосом: босс написал голосовым, просит «ответь голосом», или эмоциональный/личный момент. '
      + 'Текст здесь — ТОЛЬКО для озвучки, пользователю НЕ показывается (поэтому теги и стиль сюда, '
      + 'а не в обычный ответ). УПРАВЛЕНИЕ ИНТОНАЦИЕЙ (Gemini TTS): '
      + '1) стиль-инструкция в начале — «Скажи воодушевлённо и тепло: …», «Произнеси спокойно: …»; '
      + '2) теги в квадратных скобках внутри текста — [excited], [warmly], [thoughtful], [sighs], '
      + '[laughs], [whispers], [serious]. Можно сочетать. Пиши живо и кратко, как в разговоре. '
      + 'Если хочешь и текст, и голос — верни короткий текст обычным ответом, а развёрнутую речь '
      + 'передай сюда.',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Текст для озвучки со стилем/тегами (НЕ показывается как текст).' },
        voice: { type: 'string', description: 'Имя голоса Gemini (опц.; по умолчанию из настроек, напр. Kore, Puck).' },
      },
      required: ['text'],
    },
  },
};

async function handler(args, context = {}) {
  if (!args.text || !String(args.text).trim()) return { success: false, message: 'Нужен text для озвучки.' };
  if (context.channel === 'instagram') {
    return { success: false, message: 'Instagram не поддерживает голосовые — ответь текстом.' };
  }
  const r = await synthesizeSpeech(args.text, args.voice);
  if (!r.ok) return { success: false, message: `Не удалось озвучить: ${r.error}` };
  const sent = await notifier.deliver(context.channel, context.chatId, '', r.media);
  if (!sent) return { success: false, message: 'Озвучка готова, но не удалось отправить голосовое.' };
  voiceFlag.mark(context.channel, context.chatId); // чтобы авто-голос не продублировал
  return { success: true, source: r.source, note: 'Голосовое отправлено.' };
}

module.exports = { definition, handler };

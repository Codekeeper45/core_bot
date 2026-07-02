'use strict';
// Озвучить ответ голосом по решению агента — с управлением интонацией.
// Текст здесь ОТДЕЛЁН от отображаемого ответа: теги [] и стиль-инструкции попадают только
// в голос и не показываются пользователю. Доступен всем (гейт — TTS_ENABLED).
const { synthesizeSpeech, listVoices } = require('../services/tts');
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
        voice: { type: 'string', description: 'Имя голоса Gemini под настроение (опц.; дефолт из настроек). '
          + 'Частые: Leda — энергичный; Vindemiatrix — мягкий/утешение; Fenrir — эмоциональный/шутка; '
          + 'Gacrux — зрелый/серьёзный; Erinome — чёткий/объяснение; Alnilam — твёрдый/мотивация; '
          + 'Sulafat — тёплый/забота; Kore — нейтральный/деловой. Полный список (30) — list_voices.' },
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

// Каталог из 30 голосов с описаниями — чтобы агент осознанно выбирал голос под ситуацию.
const listVoicesTool = {
  definition: {
    type: 'function',
    function: {
      name: 'list_voices',
      description:
        'Показать полный каталог голосов (30) с характером и полом — чтобы подобрать голос под '
        + 'настроение/ситуацию перед say_voice. Имя выбранного голоса передавай в say_voice(voice=…).',
      parameters: { type: 'object', properties: {} },
    },
  },
  async handler() {
    return { success: true, count: 30, voices: listVoices() };
  },
};

const sayVoiceTool = { definition, handler };

module.exports = { tools: [sayVoiceTool, listVoicesTool] };

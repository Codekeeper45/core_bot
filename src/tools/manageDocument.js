'use strict';
// Работа с Word-документами (.docx): собрать НОВЫЙ документ из структуры и
// хирургически ПРАВИТЬ присланный договор, сохраняя его форматирование.
//   create — модель формирует spec.blocks (заголовки/абзацы/таблицы), сервис
//            docxBuilder собирает из них .docx и отправляет в чат.
//   edit   — берём оригинальный бинарник присланного .docx из docBinaryStash,
//            делаем точечные замены find→replace прямо в word/document.xml
//            (стили/таблицы/шапки целы), отправляем НОВЫМ файлом «(ред.)».
// Чтение/анализ Word отдельным инструментом не нужен: входящий .docx уже
// распарсен пайплайном media/document.js и виден модели в контексте.
const { buildDocx, editDocx } = require('../services/docxBuilder');
const docBinaryStash = require('../services/docBinaryStash');
const notifier = require('../services/notifier');
const { handleToolDbError } = require('../utils/toolError');

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const MAX_EDITS = 100;

const definition = {
  type: 'function',
  function: {
    name: 'manage_document',
    description:
      'Word-документы (.docx): создать новый или отредактировать присланный. '
      + 'action=create — собрать НОВЫЙ документ (договор, письмо, акт) из структуры spec: '
      + 'spec.blocks — массив блоков {type:"heading",level,text} | {type:"paragraph",text,bold,italic} | '
      + '{type:"table",rows:[[...],[...]],header}. До вызова уточни у человека суть и содержимое. '
      + 'action=edit — внести правки в ПРИСЛАННЫЙ ранее .docx: file="last" (или имя из [ИЗ ДОКУМЕНТА: …]), '
      + 'edits=[{find,replace}] — точная замена текста; форматирование, таблицы и шапки оригинала '
      + 'сохраняются. find должен точно совпадать с текстом в документе. Готовый файл уходит в чат. '
      + 'Ограничение edit: замена идёт по абзацу — сложное форматирование внутри заменённого участка '
      + 'нормализуется к стилю начала абзаца; ищи заменяемый текст в пределах одного абзаца.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['create', 'edit'], description: 'create — новый .docx из spec; edit — правка присланного .docx.' },
        file: { type: 'string', description: 'Для edit: имя присланного файла или "last" (последний). По умолчанию last.' },
        spec: {
          type: 'object',
          description: 'Для create: { title?, blocks:[...] }. blocks — заголовки/абзацы/таблицы по порядку.',
          properties: {
            title: { type: 'string', description: 'Заголовок документа (по центру, крупно). Опц.' },
            blocks: {
              type: 'array',
              description: 'Блоки документа по порядку.',
              items: {
                type: 'object',
                properties: {
                  type: { type: 'string', enum: ['heading', 'paragraph', 'table'], description: 'Тип блока.' },
                  level: { type: 'integer', description: 'heading: уровень 1–3.' },
                  text: { type: 'string', description: 'heading/paragraph: текст.' },
                  bold: { type: 'boolean', description: 'paragraph: жирный.' },
                  italic: { type: 'boolean', description: 'paragraph: курсив.' },
                  align: { type: 'string', enum: ['center', 'right', 'both'], description: 'paragraph: выравнивание (both = по ширине).' },
                  rows: { type: 'array', description: 'table: массив строк, каждая — массив ячеек.', items: { type: 'array', items: { type: 'string' } } },
                  header: { type: 'boolean', description: 'table: первая строка — шапка (жирная).' },
                },
              },
            },
          },
        },
        file_name: { type: 'string', description: 'Имя выходного файла (без пути). Опц.: для create по умолчанию «Документ.docx».' },
        edits: {
          type: 'array',
          description: 'Для edit: список точных замен.',
          items: {
            type: 'object',
            properties: {
              find: { type: 'string', description: 'Точный текст, который нужно заменить.' },
              replace: { type: 'string', description: 'На что заменить (пусто = удалить).' },
            },
            required: ['find'],
          },
        },
      },
      required: ['action'],
    },
  },
};

function safeName(raw, fallback) {
  const base = String(raw || '').trim().replace(/[\\/:*?"<>|]+/g, '-').slice(0, 80);
  return base || fallback;
}

function ensureDocxName(name, fallback) {
  const clean = safeName(name, fallback);
  return /\.docx$/i.test(clean) ? clean : `${clean}.docx`;
}

async function deliver(context, buffer, fileName) {
  const sent = await notifier.deliver(context.channel, context.chatId, '', {
    kind: 'document', buffer, fileName, mimetype: DOCX_MIME,
  }, { record: true });
  return sent;
}

async function handleCreate(args, context) {
  const spec = args.spec && typeof args.spec === 'object' ? args.spec : null;
  const blocks = spec && Array.isArray(spec.blocks) ? spec.blocks : [];
  if (!blocks.length && !(spec && spec.title)) {
    return { success: false, reason: 'empty_spec', message: 'Нужна структура документа: spec.blocks (и/или title).' };
  }
  const buffer = await buildDocx(spec);
  const name = ensureDocxName(args.file_name, 'Документ.docx');
  const sent = await deliver(context, buffer, name);
  if (!sent) return { success: false, reason: 'delivery_failed', message: 'Документ собран, но не удалось отправить файл в этот чат.' };
  return { success: true, action: 'create', file_name: name, blocks: blocks.length, note: 'Документ .docx отправлен.' };
}

async function handleEdit(args, context) {
  const wanted = String(args.file || 'last').trim() || 'last';
  const edits = Array.isArray(args.edits) ? args.edits.slice(0, MAX_EDITS) : [];
  if (!edits.length) return { success: false, reason: 'no_edits', message: 'Нужен список правок edits=[{find,replace}].' };

  const entry = docBinaryStash.get(context.channel, context.chatId, wanted);
  if (!entry) {
    return { success: false, reason: 'not_in_stash', message: 'Не вижу этот .docx (истёк срок хранения или бот перезапускался). Пришли документ ещё раз и повтори правку.' };
  }

  const result = await editDocx(entry.buffer, edits);
  if (result.reason === 'not_zip') {
    return { success: false, reason: 'not_docx', message: 'Это не .docx (возможно, старый формат .doc). Пересохрани как .docx и пришли снова.' };
  }
  if (result.reason === 'not_word') {
    return { success: false, reason: 'not_word', message: 'Этот файл не Word-документ — редактировать как договор нельзя.' };
  }
  if (!result.changed) {
    return {
      success: false, reason: 'no_match',
      not_found: result.notFound || [],
      message: 'Не нашёл этот текст в документе — правки не внесены. Проверь точное написание (регистр, пробелы) искомого текста.',
    };
  }

  const outName = ensureDocxName(args.file_name || `${entry.fileName.replace(/\.docx$/i, '')} (ред.)`, 'Документ (ред.).docx');
  const sent = await deliver(context, result.buffer, outName);
  if (!sent) return { success: false, reason: 'delivery_failed', message: 'Документ отредактирован, но не удалось отправить файл в этот чат.' };
  return {
    success: true, action: 'edit', file_name: outName, source: entry.fileName,
    applied: result.hits, not_found: result.notFound || [],
    note: 'Отредактированный .docx отправлен. Оригинал не изменён.',
  };
}

async function handler(args = {}, context = {}) {
  try {
    if (context.channel === 'instagram') {
      return { success: false, reason: 'channel_unsupported', message: 'В Instagram нельзя отправить Word-файл. Открой этот чат в WhatsApp или Telegram.' };
    }
    const action = String(args.action || '').trim();
    if (action === 'create') return await handleCreate(args, context);
    if (action === 'edit') return await handleEdit(args, context);
    return { success: false, reason: 'invalid_action', message: 'action должен быть create или edit.' };
  } catch (err) {
    return handleToolDbError(err);
  }
}

module.exports = { definition, handler, _internals: { ensureDocxName, safeName } };

'use strict';
// База знаний по файлам: сохранение присланных документов в векторное хранилище
// и управление ими. Текст файла берётся из docStash (пайплайн document.js кладёт
// его туда при парсинге) — LLM передаёт только имя файла и параметры нарезки,
// которые выбирает САМ по структуре документа. Поиск по содержимому — search_files.
const mysql = require('../services/mysql');
const docStash = require('../services/docStash');
const fileKnowledge = require('../services/fileKnowledge');
const { handleToolDbError } = require('../utils/toolError');

const definition = {
  type: 'function',
  function: {
    name: 'manage_files',
    description:
      'База знаний по файлам: сохранять присланные документы, таблицы и текст в векторное хранилище '
      + 'и управлять ими. Принимает любые pdf/docx/txt/csv/xlsx/ods/md/json/xml/yaml — в т.ч. крупные '
      + 'таблицы и прайсы (полный текст берётся из буфера, даже если в чате показан лишь фрагмент). '
      + 'save — сохранить присланный файл: текст УЖЕ у инструмента, передай только имя из '
      + '[ИЗ ДОКУМЕНТА: …] (или "last" = последний присланный); повтор save с тем же именем ОБНОВЛЯЕТ файл. '
      + 'Нарезку выбирай САМ по структуре: связный текст → split=paragraph, chunk_size~1500; документ '
      + 'с разделами или листами [Лист: …] → heading; таблицы/прайсы/CSV → fixed, chunk_size~2000. '
      + 'visibility: public (все, по умолчанию) / private (владелец + руководитель). list — список файлов; '
      + 'delete / set_visibility / rename — только владелец файла или руководитель; clear — удалить ВСЕ '
      + 'СВОИ файлы из базы (сначала вернёт confirm_required с числом — подтверди у человека, потом '
      + 'повтори с confirm=true). Поиск ПО СОДЕРЖИМОМУ — инструмент search_files.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['save', 'list', 'delete', 'set_visibility', 'rename', 'clear'] },
        file_name: { type: 'string', description: 'Имя файла. Для save — из [ИЗ ДОКУМЕНТА: …] или "last" (по умолчанию — последний присланный).' },
        file_id: { type: 'integer', description: 'id файла из list (альтернатива file_name для delete/set_visibility/rename).' },
        text: { type: 'string', description: 'ТОЛЬКО если save вернул not_in_stash (бот перезапускался): передай содержимое файла явно.' },
        chunk_size: { type: 'integer', description: 'Размер чанка в символах, 500–4000 (по умолчанию 1500).' },
        overlap: { type: 'integer', description: 'Перекрытие соседних чанков в символах, 0–600 (по умолчанию 150).' },
        split: { type: 'string', enum: ['paragraph', 'heading', 'fixed'], description: 'Стратегия нарезки (по умолчанию paragraph).' },
        visibility: { type: 'string', enum: ['public', 'private'], description: 'Видимость файла (по умолчанию public).' },
        description: { type: 'string', description: 'Короткое описание файла — что внутри (для list, опционально).' },
        new_name: { type: 'string', description: 'Новое имя файла (для rename).' },
        confirm: { type: 'boolean', description: 'Для clear: true = подтверждаю удаление всех своих файлов (без него вернётся confirm_required).' },
      },
      required: ['action'],
    },
  },
};

// Мутации чужих файлов — только владелец или босс (code-gate, промптом не обойти).
function canMutate(file, context) {
  if (context.role === 'boss') return true;
  return file.channel === context.channel && String(file.chat_id) === String(context.chatId);
}

async function resolveFile(args, context) {
  const viewer = { channel: context.channel, chatId: context.chatId, isBoss: context.role === 'boss' };
  return mysql.findFile({ id: args.file_id ?? null, fileName: args.file_name || null, viewer });
}

async function handler(args, context = {}) {
  try {
    const action = args.action;

    if (action === 'save') {
      let fileName = String(args.file_name || 'last').trim();
      let text = args.text ? String(args.text) : null;
      if (!text) {
        let stashed = docStash.get(context.channel, context.chatId, fileName);
        if (!stashed && typeof docStash.getPersistent === 'function') {
          try {
            stashed = await docStash.getPersistent(context.channel, context.chatId, fileName);
          } catch (err) {
            console.error('[manage_files] persistent media lookup:', err.message);
          }
        }
        if (!stashed) {
          return {
            success: false,
            reason: 'not_in_stash',
            available: docStash.list(context.channel, context.chatId),
            message: 'Текста файла нет в буфере (возможно, бот перезапускался или файл давно присылали). Попроси прислать файл заново или передай содержимое в параметре text.',
          };
        }
        fileName = stashed.fileName;
        text = stashed.text;
      } else if (!fileName || fileName.toLowerCase() === 'last') {
        return { success: false, reason: 'file_name_required', message: 'При передаче text укажи и настоящее имя файла (file_name).' };
      }

      const r = await fileKnowledge.saveFile({
        channel: context.channel,
        chatId: context.chatId,
        ownerName: context.clientName || null,
        fileName,
        text,
        chunkSize: args.chunk_size,
        overlap: args.overlap,
        split: args.split,
        visibility: args.visibility,
        description: args.description,
      });
      if (!r.ok) {
        const msg = r.reason === 'empty_text' ? 'Файл пуст — сохранять нечего.' : 'Не удалось сохранить файл.';
        return { success: false, reason: r.reason, message: msg };
      }
      return {
        success: true,
        action,
        ...r,
        note: `${r.replaced ? 'Файл обновлён' : 'Файл сохранён'} в базе знаний: «${r.file_name}», чанков: ${r.chunk_count}, видимость: ${r.visibility}.`
          + (r.embedded ? '' : ' Векторизация недоступна — поиск по этому файлу будет дословным.'),
      };
    }

    if (action === 'list') {
      const viewer = { channel: context.channel, chatId: context.chatId, isBoss: context.role === 'boss' };
      const rows = await mysql.listFiles({ viewer });
      return {
        success: true,
        action,
        count: rows.length,
        files: rows.map((f) => ({
          id: f.id,
          file_name: f.file_name,
          visibility: f.visibility,
          owner_name: f.owner_name || null,
          mine: f.channel === context.channel && String(f.chat_id) === String(context.chatId),
          description: f.description || null,
          chunk_count: f.chunk_count,
          char_count: f.char_count,
          created_at: f.created_at,
        })),
        note: rows.length ? 'Поиск по содержимому — search_files.' : 'База знаний пуста — сохрани присланный файл через save.',
      };
    }

    if (action === 'clear') {
      // Массовая очистка — только СВОИ файлы. Двухшаговое подтверждение.
      const viewer = { channel: context.channel, chatId: context.chatId, isBoss: context.role === 'boss' };
      const own = (await mysql.listFiles({ viewer }))
        .filter((f) => f.channel === context.channel && String(f.chat_id) === String(context.chatId));
      if (!own.length) return { success: true, action, deleted: 0, note: 'В твоей базе нет файлов — очищать нечего.' };
      if (args.confirm !== true) {
        return {
          success: false,
          reason: 'confirm_required',
          count: own.length,
          files: own.map((f) => f.file_name),
          message: `Удалить все свои файлы из базы знаний (${own.length} шт.)? Это необратимо — подтверди у человека, затем повтори с confirm=true.`,
        };
      }
      const r = await mysql.clearFiles({ channel: context.channel, chatId: context.chatId });
      return { success: true, action, deleted: r.deleted, note: `Удалено файлов из твоей базы знаний: ${r.deleted}.` };
    }

    if (action === 'delete' || action === 'set_visibility' || action === 'rename') {
      const file = await resolveFile(args, context);
      if (!file) return { success: false, reason: 'not_found', message: 'Файл не найден. Проверь имя/ID через list.' };
      if (!canMutate(file, context)) {
        return { success: false, reason: 'not_owner', message: 'Файл принадлежит другому пользователю — менять его может только владелец или руководитель.' };
      }
      if (action === 'delete') {
        const ok = await mysql.deleteFile(file.id);
        return ok
          ? { success: true, action, file_name: file.file_name, note: `Файл «${file.file_name}» удалён из базы знаний.` }
          : { success: false, reason: 'not_found', message: 'Файл уже удалён.' };
      }
      if (action === 'set_visibility') {
        const value = args.visibility === 'private' ? 'private' : 'public';
        const set = await mysql.setFileVisibility(file.id, value);
        return set
          ? { success: true, action, file_name: file.file_name, visibility: set, note: `«${file.file_name}» теперь ${set === 'private' ? 'приватный (видят владелец и руководитель)' : 'публичный (видят все)'}.` }
          : { success: false, reason: 'not_found', message: 'Файл не найден.' };
      }
      const newName = String(args.new_name || '').trim();
      if (!newName) return { success: false, reason: 'new_name_required', message: 'Нужно новое имя (new_name).' };
      const ok = await mysql.renameFile(file.id, newName);
      return ok
        ? { success: true, action, old_name: file.file_name, file_name: newName, note: `«${file.file_name}» → «${newName}».` }
        : { success: false, reason: 'not_found', message: 'Файл не найден.' };
    }

    return { success: false, reason: 'invalid_action' };
  } catch (err) {
    return handleToolDbError(err);
  }
}

module.exports = { definition, handler };

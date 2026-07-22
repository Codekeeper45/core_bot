'use strict';

process.env.OBSERVE_ONLY_GROUP_WA = '120363000000000000@g.us';
process.env.GROUP_REPORT_REQUESTER_NAMES = 'Стас';

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');

let rows = [];
let lastArchiveArgs = null;
let semanticResult = { ok: false, reason: 'disabled', results: [] };
let lastSemanticArgs = null;
let observedAudio = null;
let lastAudioArgs = null;
let savedTranscript = null;
const mysqlMock = {
  archiveChatPage: async (args) => {
    lastArchiveArgs = args;
    return rows;
  },
  getObservedGroupAudio: async (args) => {
    lastAudioArgs = args;
    return observedAudio;
  },
  saveObservedGroupAudioTranscript: async (id, transcript) => { savedTranscript = { id, transcript }; },
};
const memorySearchMock = {
  semanticRecall: async (args) => {
    lastSemanticArgs = args;
    return semanticResult;
  },
};
const mediaMock = { transcribeAudio: async () => 'Повторная транскрипция голосового.' };

const originalRequire = Module.prototype.require;
Module.prototype.require = function (id) {
  if (id === '../services/mysql') return mysqlMock;
  if (id === '../services/memorySearch') return memorySearchMock;
  if (id === '../services/openrouterMedia') return mediaMock;
  return originalRequire.apply(this, arguments);
};
delete require.cache[require.resolve('../../src/tools/groupReport')];
const { handler } = require('../../src/tools/groupReport');
Module.prototype.require = originalRequire;

const STAS = { channel: 'whatsapp', chatId: '77070001122@s.whatsapp.net', clientName: 'Стас', role: 'employee' };
const BOSS = { channel: 'whatsapp', chatId: '77070009999@s.whatsapp.net', clientName: 'Em', role: 'boss' };

describe('group_report', () => {
  beforeEach(() => {
    rows = [];
    lastArchiveArgs = null;
    semanticResult = { ok: false, reason: 'disabled', results: [] };
    lastSemanticArgs = null;
    observedAudio = null;
    lastAudioArgs = null;
    savedTranscript = null;
  });

  test('не назначенный пользователь не получает архив группы', async () => {
    const result = await handler({}, { channel: 'whatsapp', chatId: '77070009999@s.whatsapp.net', clientName: 'Иван' });
    assert.equal(result.success, false);
    assert.equal(result.reason, 'not_allowed');
    assert.equal(lastArchiveArgs, null);
  });

  test('руководитель получает отчёт без отдельной записи в списке запросчиков', async () => {
    rows = [{ id: 1, actor_name: 'Иван', content: 'Машина выехала', created_at: '2026-07-22 05:00:00' }];
    const result = await handler({ mode: 'all' }, BOSS);
    assert.equal(result.success, true);
    assert.equal(result.count, 1);
    assert.equal(lastArchiveArgs.chatId, '120363000000000000@g.us');
  });

  test('date возвращает страницу и честно сообщает о продолжении', async () => {
    rows = [
      { id: 1, actor_name: 'Иван', content: 'Машина выехала', created_at: '2026-07-22 05:00:00' },
      { id: 2, actor_name: 'Али', content: 'Нужна накладная', created_at: '2026-07-22 06:00:00' },
      { id: 3, actor_name: 'Иван', content: 'Фото отгрузки', created_at: '2026-07-22 07:00:00' },
    ];
    const result = await handler({ mode: 'date', from: '2026-07-22', to: '2026-07-22', limit: 2 }, STAS);
    assert.equal(result.success, true);
    assert.equal(result.count, 2);
    assert.equal(result.page.has_more, true);
    assert.equal(result.page.next_cursor, 2);
    assert.deepEqual(result.participants, ['Иван', 'Али']);
    assert.equal(lastArchiveArgs.afterId, 0);
    assert.equal(lastArchiveArgs.limit, 3);
  });

  test('cursor продолжает тот же период с последнего id', async () => {
    rows = [{ id: 3, actor_name: 'Иван', content: 'Фото отгрузки', created_at: '2026-07-22 07:00:00' }];
    const result = await handler({ mode: 'date', from: '2026-07-22', to: '2026-07-22', cursor: 2 }, STAS);
    assert.equal(result.success, true);
    assert.equal(result.count, 1);
    assert.equal(result.page.has_more, false);
    assert.equal(result.page.next_cursor, null);
    assert.equal(lastArchiveArgs.afterId, 2);
  });

  test('all читает весь архив без искусственного ограничения датами', async () => {
    rows = [{ id: 1, actor_name: 'Иван', content: 'Старая отгрузка', created_at: '2024-01-01 05:00:00' }];
    const result = await handler({ mode: 'all', limit: 10 }, STAS);
    assert.equal(result.success, true);
    assert.equal(result.range.from, null);
    assert.equal(result.range.to, null);
    assert.equal(lastArchiveArgs.fromUtc, null);
    assert.equal(lastArchiveArgs.toUtc, null);
  });

  test('semantic ищет только в JID группы и передаёт период', async () => {
    semanticResult = {
      ok: true,
      scanned: 4,
      truncated: false,
      results: [{
        score: 0.8123,
        first_at: '2026-07-20 05:00:00',
        last_at: '2026-07-20 06:00:00',
        authors: 'Иван, Али',
        msg_count: 10,
        content: 'Обсуждение задержки машины',
      }],
    };
    const result = await handler({ mode: 'semantic', query: 'машина задержалась', from: '2026-07-20', to: '2026-07-20' }, STAS);
    assert.equal(result.success, true);
    assert.equal(result.search_mode, 'semantic');
    assert.equal(result.chunks[0].score, 0.812);
    assert.equal(lastSemanticArgs.chatId, '120363000000000000@g.us');
    assert.equal(lastSemanticArgs.scope, 'chat');
    assert.equal(lastSemanticArgs.fromUtc.toISOString(), '2026-07-19T19:00:00.000Z');
    assert.equal(lastArchiveArgs, null);
  });

  test('semantic без индекса делает keyword fallback и помечает причину', async () => {
    rows = [{ id: 7, actor_name: 'Али', content: 'Задержка машины', created_at: '2026-07-20 06:00:00' }];
    const result = await handler({ mode: 'semantic', query: 'задержка машины', limit: 10 }, STAS);
    assert.equal(result.success, true);
    assert.equal(result.search_mode, 'keyword_fallback');
    assert.equal(result.fallback_reason, 'disabled');
    assert.equal(lastArchiveArgs.tokens.length, 2);
  });

  test('audio повторно транскрибирует сохранённый оригинал выбранного автора', async () => {
    observedAudio = {
      id: 12, actor_name: 'Заиндин', mime_type: 'audio/ogg', audio_data: Buffer.from('voice'),
      transcript: null, created_at: '2026-07-22 10:00:00',
    };
    const result = await handler({ mode: 'audio', speaker: 'Заиндин', retry: true }, BOSS);
    assert.equal(result.success, true);
    assert.equal(result.audio.id, 12);
    assert.equal(result.audio.transcript, 'Повторная транскрипция голосового.');
    assert.equal(lastAudioArgs.speaker, 'Заиндин');
    assert.deepEqual(savedTranscript, { id: 12, transcript: 'Повторная транскрипция голосового.' });
  });

  test('audio честно сообщает, когда старый оригинал не был сохранён', async () => {
    const result = await handler({ mode: 'audio', speaker: 'Заиндин' }, BOSS);
    assert.equal(result.success, false);
    assert.equal(result.reason, 'audio_not_saved');
  });

  test('keyword требует query', async () => {
    const result = await handler({ mode: 'keyword' }, STAS);
    assert.equal(result.success, false);
    assert.equal(result.reason, 'query_required');
  });

  test('некорректный cursor не превращается молча в первую страницу', async () => {
    const result = await handler({ mode: 'all', cursor: 'oops' }, STAS);
    assert.equal(result.success, false);
    assert.equal(result.reason, 'bad_cursor');
  });

  test('пустой архив возвращает честное сообщение без выдумок', async () => {
    const result = await handler({ mode: 'all' }, STAS);
    assert.equal(result.success, true);
    assert.equal(result.count, 0);
    assert.match(result.note, /данные архива|не найдено/i);
  });
});

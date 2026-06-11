'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { deflateSync, inflateSync } = require('node:zlib');

// ── render_diagram: kroki-кодирование детерминировано и обратимо ──────────────
describe('render_diagram', () => {
  const delivered = [];
  const Module = require('module');
  const orig = Module.prototype.require;
  Module.prototype.require = function (id) {
    if (id === '../services/notifier') return { deliver: async (ch, c, t, media) => { delivered.push({ ch, media }); return true; } };
    return orig.apply(this, arguments);
  };
  const tool = require('../src/tools/renderDiagram');
  Module.prototype.require = orig;

  test('кодирует mermaid в kroki base64url (deflate, обратимо) и шлёт картинкой', async () => {
    // мок fetch → возвращаем «PNG»
    const realFetch = global.fetch;
    global.fetch = async (url) => {
      // декодируем обратно из URL — проверяем корректность кодирования
      const enc = url.split('/mermaid/png/')[1];
      const code = inflateSync(Buffer.from(enc, 'base64url')).toString();
      assert.match(code, /flowchart/);
      return { ok: true, arrayBuffer: async () => Buffer.from('PNGDATA') };
    };
    delivered.length = 0;
    const r = await tool.handler({ mermaid_code: 'flowchart TD\n A-->B', caption: 'тест' }, { channel: 'telegram', chatId: '1' });
    global.fetch = realFetch;
    assert.equal(r.success, true);
    assert.equal(delivered[0].media.kind, 'image');
    assert.equal(delivered[0].media.caption, 'тест');
  });

  test('ошибка kroki → fail-soft', async () => {
    const realFetch = global.fetch;
    global.fetch = async () => ({ ok: false, status: 400 });
    const r = await tool.handler({ mermaid_code: 'bad' }, { channel: 'telegram', chatId: '1' });
    global.fetch = realFetch;
    assert.equal(r.success, false);
    assert.match(r.message, /kroki|синтаксис/i);
  });

  test('deflate→base64url совпадает с эталоном zlib', () => {
    const enc = deflateSync(Buffer.from('pie title T')).toString('base64url');
    assert.equal(inflateSync(Buffer.from(enc, 'base64url')).toString(), 'pie title T');
  });
});

// ── web_search: парсинг Brave + кэш + отказ без ключа ─────────────────────────
describe('web_search service', () => {
  test('парсит Brave web.results, нет ключа → отказ, кэш на повтор', async () => {
    const Module = require('module');
    const orig = Module.prototype.require;
    let cfg = { BRAVE_API_KEY: '' };
    Module.prototype.require = function (id) {
      if (id === '../config') return cfg;
      return orig.apply(this, arguments);
    };
    delete require.cache[require.resolve('../src/services/webSearch')];
    const svc = require('../src/services/webSearch');
    Module.prototype.require = orig;

    // нет ключа
    const no = await svc.search('test');
    assert.equal(no.ok, false);
    assert.match(no.error, /BRAVE_API_KEY/);

    // с ключом — мок fetch
    cfg.BRAVE_API_KEY = 'k';
    let calls = 0;
    const realFetch = global.fetch;
    global.fetch = async () => { calls++; return { ok: true, json: async () => ({ web: { results: [
      { title: 'A', url: 'http://a', description: 'da' },
      { title: 'B', url: 'http://b', description: 'db' },
    ] } }) }; };
    const r1 = await svc.search('цена лотков', 2);
    assert.equal(r1.ok, true);
    assert.equal(r1.results.length, 2);
    assert.equal(r1.results[0].title, 'A');
    // повтор того же запроса → из кэша, fetch не вызывается второй раз
    const r2 = await svc.search('цена лотков', 2);
    assert.equal(r2.cached, true);
    assert.equal(calls, 1);
    global.fetch = realFetch;
  });
});

// ── tts: PCM→WAV заголовок корректен; ротация ключей; ветка отказа ────────────
describe('tts', () => {
  const { _internals } = require('../src/services/tts');
  test('pcmToWav пишет валидный RIFF/WAVE заголовок', () => {
    const pcm = Buffer.alloc(100, 1);
    const wav = _internals.pcmToWav(pcm, 24000);
    assert.equal(wav.slice(0, 4).toString(), 'RIFF');
    assert.equal(wav.slice(8, 12).toString(), 'WAVE');
    assert.equal(wav.length, 44 + 100);
    assert.equal(wav.readUInt32LE(24), 24000); // sample rate
  });

  test('googleKeysRotated: круговая ротация старта по запросам', () => {
    const Module = require('module');
    const orig = Module.prototype.require;
    const cfg = { GOOGLE_GENAI_API_KEYS: ['k1', 'k2', 'k3'], GOOGLE_GENAI_API_KEY: '' };
    Module.prototype.require = function (id) {
      if (id === '../config') return cfg;
      return orig.apply(this, arguments);
    };
    delete require.cache[require.resolve('../src/services/tts')];
    const tts = require('../src/services/tts');
    Module.prototype.require = orig;
    // каждый вызов начинается со следующего ключа, но содержит ВСЕ ключи (для перебора при 429)
    assert.deepEqual(tts._internals.googleKeysRotated(), ['k1', 'k2', 'k3']);
    assert.deepEqual(tts._internals.googleKeysRotated(), ['k2', 'k3', 'k1']);
    assert.deepEqual(tts._internals.googleKeysRotated(), ['k3', 'k1', 'k2']);
    assert.deepEqual(tts._internals.googleKeysRotated(), ['k1', 'k2', 'k3']); // цикл
    delete require.cache[require.resolve('../src/services/tts')]; // восстановить для других тестов
  });

  test('synthesizeSpeech без ключей → честный отказ (без сетевых вызовов)', async () => {
    const Module = require('module');
    const orig = Module.prototype.require;
    Module.prototype.require = function (id) {
      if (id === '../config') return { GOOGLE_GENAI_API_KEYS: [], GOOGLE_GENAI_API_KEY: '', OPENROUTER_API_KEY: '', TTS_VOICE: 'Kore' };
      return orig.apply(this, arguments);
    };
    delete require.cache[require.resolve('../src/services/tts')];
    const { synthesizeSpeech } = require('../src/services/tts');
    Module.prototype.require = orig;
    const r = await synthesizeSpeech('привет');
    delete require.cache[require.resolve('../src/services/tts')];
    assert.equal(r.ok, false);
    assert.match(r.error, /TTS не настроен/);
  });
});

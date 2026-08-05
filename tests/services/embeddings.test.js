'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const config = require('../../src/config');
const emb = require('../../src/services/embeddings');

describe('embeddings: чистые хелперы', () => {
  test('truncateNormalize: длина N и норма ≈ 1', () => {
    const v = emb.truncateNormalize([3, 4, 9, 9], 2); // усечь до 2 → [3,4] → норм
    assert.equal(v.length, 2);
    assert.ok(Math.abs(v[0] - 0.6) < 1e-6 && Math.abs(v[1] - 0.8) < 1e-6);
    const norm = Math.sqrt(v[0] * v[0] + v[1] * v[1]);
    assert.ok(Math.abs(norm - 1) < 1e-6);
  });

  test('truncateNormalize: пустой/битый вход → []', () => {
    assert.deepEqual(emb.truncateNormalize([], 4), []);
    assert.deepEqual(emb.truncateNormalize(null, 4), []);
  });

  test('pack/unpack Float32 roundtrip', () => {
    const src = emb.truncateNormalize([0.1, 0.2, 0.3, 0.4], 4);
    const buf = emb.packFloat32(src);
    assert.ok(Buffer.isBuffer(buf));
    assert.equal(buf.length, 4 * 4);
    const back = emb.unpackFloat32(buf);
    assert.equal(back.length, 4);
    for (let i = 0; i < 4; i++) assert.ok(Math.abs(back[i] - src[i]) < 1e-6);
  });

  test('cosine: идентичные = 1, ортогональные = 0', () => {
    assert.ok(Math.abs(emb.cosine([1, 0], [1, 0]) - 1) < 1e-9);
    assert.ok(Math.abs(emb.cosine([1, 0], [0, 1])) < 1e-9);
  });

  test('dot нормированных = косинус', () => {
    const a = emb.truncateNormalize([1, 2, 3], 3);
    const b = emb.truncateNormalize([2, 1, 0], 3);
    assert.ok(Math.abs(emb.dot(a, b) - emb.cosine(a, b)) < 1e-6);
  });
});

describe('embeddings: embed() через замоканный fetch', () => {
  test('возвращает нормированные векторы длины EMBEDDING_DIMENSIONS, в порядке input', async () => {
    const savedKey = config.OPENROUTER_API_KEY;
    const savedGoogle = config.GOOGLE_GEMINI_API_KEYS;
    const savedGoogleSingle = config.GOOGLE_GEMINI_API_KEY;
    const savedDims = config.EMBEDDING_DIMENSIONS;
    const savedFetch = global.fetch;
    config.OPENROUTER_API_KEY = 'test-key';
    config.GOOGLE_GEMINI_API_KEYS = [];
    config.GOOGLE_GEMINI_API_KEY = '';
    config.EMBEDDING_DIMENSIONS = 3;
    let seenBody = null;
    global.fetch = async (url, opts) => {
      seenBody = JSON.parse(opts.body);
      return {
        ok: true,
        json: async () => ({
          data: [
            { index: 1, embedding: [0, 3, 4, 99] },
            { index: 0, embedding: [3, 4, 0, 99] },
          ],
        }),
      };
    };
    try {
      const out = await emb.embed(['первый', 'второй']);
      assert.equal(out.length, 2);
      // index=0 должен оказаться первым после сортировки
      assert.equal(out[0].length, 3);
      assert.ok(Math.abs(out[0][0] - 0.6) < 1e-6); // [3,4,0] норм → 0.6
      assert.ok(Math.abs(out[1][1] - 0.6) < 1e-6); // [0,3,4] норм → 0.6
      assert.equal(seenBody.model, config.EMBEDDING_MODEL);
      assert.deepEqual(seenBody.input, ['первый', 'второй']);
    } finally {
      config.OPENROUTER_API_KEY = savedKey;
      config.GOOGLE_GEMINI_API_KEYS = savedGoogle;
      config.GOOGLE_GEMINI_API_KEY = savedGoogleSingle;
      config.EMBEDDING_DIMENSIONS = savedDims;
      global.fetch = savedFetch;
    }
  });

  test('embed бросает при выключенных эмбеддингах', async () => {
    const savedKey = config.OPENROUTER_API_KEY;
    const savedGoogle = config.GOOGLE_GEMINI_API_KEYS;
    const savedGoogleSingle = config.GOOGLE_GEMINI_API_KEY;
    config.OPENROUTER_API_KEY = '';
    config.GOOGLE_GEMINI_API_KEYS = [];
    config.GOOGLE_GEMINI_API_KEY = '';
    try {
      await assert.rejects(() => emb.embed(['x']), /embeddings_disabled/);
    } finally {
      config.OPENROUTER_API_KEY = savedKey;
      config.GOOGLE_GEMINI_API_KEYS = savedGoogle;
      config.GOOGLE_GEMINI_API_KEY = savedGoogleSingle;
    }
  });
});

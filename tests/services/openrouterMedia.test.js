'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { _internals } = require('../../src/services/openrouterMedia');

test('в media-цепочку проходят только модели с гарантированно бесплатным slug', () => {
  const chain = _internals.freeModelChain(
    'openai/whisper-large-v3-turbo',
    'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free',
    'openrouter/free'
  );
  assert.deepEqual(chain, [
    'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free',
    'openrouter/free',
  ]);
});

test('Nemotron остаётся последним media fallback после OpenRouter Free', () => {
  const chain = _internals.mediaModelChainWithLastResort(
    'openai/whisper-large-v3-turbo',
    'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free',
    'openrouter/free'
  );
  assert.deepEqual(chain, [
    'openrouter/free',
    'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free',
  ]);
});

test('прямой NVIDIA NIM media route отделён от OpenRouter slug', () => {
  assert.equal(_internals.nvidiaMediaRoute(), 'nvidia_nim_media:nvidia/nemotron-3-nano-omni-30b-a3b-reasoning');
});

test('платные OpenRouter media-модели не считаются бесплатными', () => {
  assert.equal(_internals.isFreeOpenRouterModel('google/gemini-3.1-flash-lite-preview'), false);
  assert.equal(_internals.isFreeOpenRouterModel('openrouter/free'), true);
  assert.equal(_internals.isFreeOpenRouterModel('vendor/model:free'), true);
});

test('аудиоформат корректно определяется для WhatsApp и видео', () => {
  assert.equal(_internals.detectAudioFormat('audio/ogg; codecs=opus'), 'ogg');
  assert.equal(_internals.detectAudioFormat('video/mp4'), 'mp4');
});

test('текст извлекается из нового Gemini interactions response', () => {
  const text = _internals.interactionText({
    steps: [
      { type: 'thought', signature: 'hidden' },
      { type: 'model_output', content: [{ type: 'text', text: 'Описание видео' }] },
    ],
  });
  assert.equal(text, 'Описание видео');
});

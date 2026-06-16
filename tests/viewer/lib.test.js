'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { digits, empKey, resolveName, cleanMessages, previewOf, toolResultNote } = require('../../viewer/lib');

describe('viewer/lib: cleanMessages', () => {
  test('разбирает user/assistant/tool, прячет system', () => {
    const raw = [
      { role: 'system', content: 'промпт' },
      { role: 'user', content: 'привет' },
      { role: 'assistant', content: 'здравствуйте' },
      { role: 'tool', tool_call_id: 'x', content: '{"success":true,"note":"переслано"}' },
    ];
    const out = cleanMessages(raw);
    assert.equal(out.length, 3); // system скрыт
    assert.deepEqual(out[0], { role: 'user', text: 'привет' });
    assert.equal(out[1].role, 'assistant');
    assert.equal(out[2].role, 'tool');
    assert.match(out[2].text, /✓/);
    assert.match(out[2].text, /переслано/);
  });

  test('assistant с tool_calls без текста → tools заполнены', () => {
    const out = cleanMessages([
      { role: 'assistant', content: null, tool_calls: [{ function: { name: 'forward_message' } }, { function: { name: 'message_employee' } }] },
    ]);
    assert.equal(out[0].role, 'assistant');
    assert.equal(out[0].text, '');
    assert.deepEqual(out[0].tools, ['forward_message', 'message_employee']);
  });

  test('content массивом (vision) → собирает текст', () => {
    const out = cleanMessages([{ role: 'user', content: [{ type: 'text', text: 'что тут' }, { type: 'image_url' }] }]);
    assert.equal(out[0].text, 'что тут');
  });

  test('не массив / мусор → [] без исключений', () => {
    assert.deepEqual(cleanMessages(null), []);
    assert.deepEqual(cleanMessages('х'), []);
    assert.deepEqual(cleanMessages([null, 5, {}, { role: 'weird' }]), []);
  });
});

describe('viewer/lib: toolResultNote', () => {
  test('success:false → ✗ и сообщение', () => {
    assert.match(toolResultNote('{"success":false,"message":"нет контакта"}'), /✗.*нет контакта/);
  });
  test('не JSON → обрезанный текст', () => {
    assert.equal(toolResultNote('просто текст'), 'просто текст');
  });
});

describe('viewer/lib: resolveName / empKey', () => {
  const map = new Map([
    [empKey('whatsapp', '+7 707 111 22 33'), 'Иван'],
    [empKey('telegram', '12345678'), 'Пётр'],
  ]);
  test('whatsapp: jid с @ матчится по цифрам', () => {
    assert.equal(resolveName('whatsapp', '77071112233@s.whatsapp.net', map), 'Иван');
  });
  test('telegram: числовой chat_id матчится как есть', () => {
    assert.equal(resolveName('telegram', '12345678', map), 'Пётр');
  });
  test('незнакомец → null', () => {
    assert.equal(resolveName('whatsapp', '70000000000@s.whatsapp.net', map), null);
    assert.equal(resolveName('instagram', 'abc', map), null);
  });
  test('digits вытаскивает только цифры', () => {
    assert.equal(digits('+7 (707) 111-22-33'), '77071112233');
  });
});

describe('viewer/lib: previewOf', () => {
  test('count и последняя непустая реплика', () => {
    const pv = previewOf([
      { role: 'user', content: 'первое' },
      { role: 'assistant', content: 'ответ бота' },
      { role: 'tool', content: '{"success":true}' },
    ]);
    assert.equal(pv.count, 3);
    assert.equal(pv.last.role, 'tool');
    assert.ok(pv.last.text.length > 0);
  });
  test('последняя content-реплика, если хвост пустой assistant', () => {
    const pv = previewOf([
      { role: 'user', content: 'вопрос' },
      { role: 'assistant', content: '', tool_calls: [{ function: { name: 'web_search' } }] },
    ]);
    assert.equal(pv.count, 2);
    assert.match(pv.last.text, /web_search/);
  });
  test('пусто → count 0, last null', () => {
    const pv = previewOf([]);
    assert.equal(pv.count, 0);
    assert.equal(pv.last, null);
  });
});

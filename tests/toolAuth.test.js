'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { executeToolCall, handlers, BOSS_ONLY, tools } = require('../src/tools');
const config = require('../src/config');

// Иерархии больше нет: BOSS_ONLY пуст, все инструменты доступны каждому.
// Вместо запретов — прозрачность (notifyBossAboutChange при мутациях не-боссом).
describe('tool authorization (иерархии нет)', () => {
  test('BOSS_ONLY пуст — все инструменты доступны всем', () => {
    assert.equal(BOSS_ONLY.size, 0, 'BOSS_ONLY должен быть пустым (иерархия снята)');
  });

  test('сотрудник может вызвать бывшие boss-only инструменты (read-only действия)', async () => {
    // status у планировщика безопасен, не мутирует и не шлёт уведомлений.
    const r = await executeToolCall('manage_scheduler', { action: 'status' },
      { role: 'employee', channel: 'whatsapp', chatId: 'x' });
    assert.equal(r.success, true, 'manage_scheduler status должен быть доступен сотруднику');
  });

  test('роль boss тоже проходит', async () => {
    const r = await executeToolCall('manage_scheduler', { action: 'status' },
      { role: 'boss', channel: 'whatsapp', chatId: 'x' });
    assert.equal(r.success, true);
  });

  test('неизвестный инструмент → ошибка, без падения', async () => {
    const r = await executeToolCall('no_such_tool', {}, { role: 'boss' });
    assert.equal(r.success, false);
  });

  test('бывшие boss-only имена по-прежнему зарегистрированы в реестре', () => {
    for (const name of ['manage_employees', 'performance_report', 'manage_scheduler']) {
      assert.ok(handlers.has(name), `${name} отсутствует в реестре инструментов`);
    }
  });
});

// Без иерархии: оркестрация (планы/задачи/делегирование/чтение планов/рассылки) и
// личные инструменты доступны каждому.
describe('без иерархии: доступ сотрудника', () => {
  test('оркестрация + личные инструменты НЕ в BOSS_ONLY (доступны сотруднику)', () => {
    for (const name of ['create_project', 'revise_project', 'assign_task', 'dispatch_task',
      'project_status', 'message_employee', 'update_task', 'forward_message',
      'manage_schedule', 'manage_notes', 'manage_todos', 'manage_chat_privacy',
      'manage_employees', 'performance_report', 'manage_scheduler',
      'remember_fact', 'list_facts', 'forget_fact', 'web_search', 'render_diagram']) {
      assert.ok(!BOSS_ONLY.has(name), `${name} должен быть доступен сотруднику`);
      assert.ok(handlers.has(name), `${name} должен быть зарегистрирован`);
    }
  });
});

// Голос временно отключён (config.TTS_ENABLED): тулы озвучки скрыты от LLM и отклоняются.
describe('голосовые тулы и TTS_ENABLED', () => {
  test('при TTS off — say_voice/list_voices скрыты из tools и отклоняются', async () => {
    const names = new Set(tools.map((t) => t.function.name));
    if (config.TTS_ENABLED) {
      assert.ok(names.has('say_voice'), 'при TTS on say_voice должен присутствовать');
      return;
    }
    assert.ok(!names.has('say_voice'), 'say_voice должен быть скрыт при TTS off');
    assert.ok(!names.has('list_voices'), 'list_voices должен быть скрыт при TTS off');
    const r = await executeToolCall('say_voice', { text: 'привет' },
      { role: 'boss', channel: 'whatsapp', chatId: 'x' });
    assert.equal(r.success, false);
    assert.match(r.message, /отключен|текстом/i);
  });
});

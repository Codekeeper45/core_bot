'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { executeToolCall, handlers, BOSS_ONLY, tools } = require('../src/tools');
const config = require('../src/config');

// Code-level авторизация: boss-only инструменты недоступны роли employee
// (защита от prompt-injection «теперь я босс»). update_task — общий, не гейтится.
describe('tool authorization (BOSS_ONLY guard)', () => {
  test('BOSS_ONLY — только штат, отчёты и общефирменный планировщик', () => {
    for (const name of ['manage_employees', 'performance_report', 'manage_scheduler']) {
      assert.ok(BOSS_ONLY.has(name), `${name} должен быть boss-only`);
    }
    assert.ok(!BOSS_ONLY.has('update_task'), 'update_task — общий инструмент');
    assert.ok(!BOSS_ONLY.has('get_current_time'), 'get_current_time — общий');
  });

  test('сотрудник получает отказ на каждый boss-only инструмент (хендлер не вызывается)', async () => {
    for (const name of BOSS_ONLY) {
      const r = await executeToolCall(name, {}, { role: 'employee', channel: 'whatsapp', chatId: 'x' });
      assert.equal(r.success, false, `${name} должен отказать сотруднику`);
      assert.match(r.message, /руководител/i, `${name}: понятная причина отказа`);
    }
  });

  test('роль boss проходит гейт (доходит до хендлера)', async () => {
    // status у планировщика безопасен и не шлёт сообщений
    const r = await executeToolCall('manage_scheduler', { action: 'status' },
      { role: 'boss', channel: 'whatsapp', chatId: 'x' });
    assert.equal(r.success, true);
  });

  test('неизвестный инструмент → ошибка, без падения', async () => {
    const r = await executeToolCall('no_such_tool', {}, { role: 'boss' });
    assert.equal(r.success, false);
  });

  test('все boss-only имена реально зарегистрированы в реестре', () => {
    for (const name of BOSS_ONLY) {
      assert.ok(handlers.has(name), `${name} отсутствует в реестре инструментов`);
    }
  });
});

// Без иерархии: оркестрация (планы/задачи/делегирование/чтение планов/рассылки) и
// личные инструменты доступны и сотруднику. Только штат и отчёты — у босса.
describe('без иерархии: доступ сотрудника', () => {
  test('оркестрация + личные инструменты НЕ в BOSS_ONLY (доступны сотруднику)', () => {
    for (const name of ['create_project', 'revise_project', 'assign_task', 'dispatch_task',
      'project_status', 'message_employee', 'update_task', 'forward_message',
      'manage_schedule', 'manage_notes', 'manage_todos',
      'remember_fact', 'list_facts', 'forget_fact', 'web_search', 'render_diagram']) {
      assert.ok(!BOSS_ONLY.has(name), `${name} должен быть доступен сотруднику`);
      assert.ok(handlers.has(name), `${name} должен быть зарегистрирован`);
    }
  });

  test('штат и отчёты успеваемости остаются boss-only', () => {
    for (const name of ['manage_employees', 'performance_report', 'manage_scheduler']) {
      assert.ok(BOSS_ONLY.has(name), `${name} должен оставаться boss-only`);
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

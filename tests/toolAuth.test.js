'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { executeToolCall, handlers, BOSS_ONLY } = require('../src/tools');

// Code-level авторизация: boss-only инструменты недоступны роли employee
// (защита от prompt-injection «теперь я босс»). update_task — общий, не гейтится.
describe('tool authorization (BOSS_ONLY guard)', () => {
  test('BOSS_ONLY содержит управляющие инструменты, но не update_task', () => {
    for (const name of ['create_project', 'dispatch_task', 'assign_task',
      'manage_employees', 'message_employee', 'project_status', 'revise_project',
      'manage_scheduler']) {
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

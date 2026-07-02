'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { toolsForRole, tools, BOSS_ONLY } = require('../../src/tools');
const names = (list) => list.map((t) => t.function.name);

describe('toolsForRole (иерархии нет)', () => {
  test('boss видит все инструменты', () => {
    assert.equal(names(toolsForRole('boss')).length, tools.length);
  });

  test('сотрудник видит ВСЕ инструменты (BOSS_ONLY пуст)', () => {
    const emp = names(toolsForRole('employee'));
    assert.equal(BOSS_ONLY.size, 0);
    assert.equal(emp.length, tools.length);
    for (const n of ['manage_employees', 'performance_report', 'manage_scheduler']) {
      assert.ok(emp.includes(n), `сотрудник должен видеть ${n}`);
    }
  });

  test('сотрудник видит оркестрацию и связь', () => {
    const emp = names(toolsForRole('employee'));
    for (const n of ['create_project', 'dispatch_task', 'project_status', 'message_employee', 'message_boss', 'manage_chat_privacy']) {
      assert.ok(emp.includes(n), `сотрудник должен видеть ${n}`);
    }
  });

  test('исходный массив tools не мутируется', () => {
    const before = tools.length;
    toolsForRole('employee');
    assert.equal(tools.length, before);
  });
});

describe('описания инструментов = реальному доступу (M2)', () => {
  const byName = (n) => tools.find((t) => t.function.name === n);
  test('message_employee не помечен как boss-only в описании', () => {
    const d = byName('message_employee').function.description;
    assert.doesNotMatch(d, /режима БОССА/i);
  });
  test('message_boss не привязан к «режиму сотрудника» в описании', () => {
    const d = byName('message_boss').function.description;
    assert.doesNotMatch(d, /в режиме сотрудника/i);
  });
  test('в описаниях нет «только босс/режим босса»', () => {
    for (const t of tools) {
      assert.doesNotMatch(t.function.description, /только босс|режим босса/i, t.function.name);
    }
  });
});

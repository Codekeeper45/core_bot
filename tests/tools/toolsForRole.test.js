'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { toolsForRole, tools, BOSS_ONLY } = require('../../src/tools');
const names = (list) => list.map((t) => t.function.name);

describe('toolsForRole', () => {
  test('boss видит все инструменты, включая boss-only', () => {
    const boss = names(toolsForRole('boss'));
    for (const n of BOSS_ONLY) assert.ok(boss.includes(n), `boss должен видеть ${n}`);
    assert.equal(boss.length, tools.length);
  });

  test('сотрудник НЕ видит ни одного boss-only инструмента', () => {
    const emp = names(toolsForRole('employee'));
    for (const n of BOSS_ONLY) assert.ok(!emp.includes(n), `сотрудник не должен видеть ${n}`);
  });

  test('сотрудник видит оркестрацию и связь (иерархии нет)', () => {
    const emp = names(toolsForRole('employee'));
    for (const n of ['create_project', 'dispatch_task', 'project_status', 'message_employee', 'message_boss']) {
      assert.ok(emp.includes(n), `сотрудник должен видеть ${n}`);
    }
    assert.equal(emp.length, tools.length - BOSS_ONLY.size);
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
});

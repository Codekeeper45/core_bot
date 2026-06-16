'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

// Общий мок mysql для фактов и личных задач/заметок.
const db = { facts: [], items: [], nextId: 1 };
const mysqlMock = {
  addFact: async (ch, id, fact, cat, scope = 'personal') => {
    const sc = scope === 'global' ? 'global' : 'personal';
    const dup = db.facts.find((f) => f.scope === sc && f.fact.toLowerCase().trim() === String(fact).toLowerCase().trim());
    if (dup) return { id: dup.id, duplicate: true, scope: sc };
    const row = { id: db.nextId++, fact, category: cat, scope: sc };
    db.facts.push(row); return { id: row.id, duplicate: false, scope: sc };
  },
  listFacts: async () => db.facts.slice().reverse(),
  deleteFact: async (ch, id, { id: fid, match }) => {
    const before = db.facts.length;
    if (fid) db.facts = db.facts.filter((f) => f.id !== fid);
    else if (match) { const hit = db.facts.find((f) => f.fact.toLowerCase().includes(match.toLowerCase())); if (hit) db.facts = db.facts.filter((f) => f.id !== hit.id); }
    return before - db.facts.length;
  },
  addPersonalItem: async (ch, id, kind, text, due) => {
    const row = { id: db.nextId++, kind, text, due: due || null, done: 0 };
    db.items.push(row); return row.id;
  },
  listPersonalItems: async (ch, id, kind, incDone) => db.items.filter((i) => i.kind === kind && (incDone || !i.done)),
  setPersonalItemDone: async (ch, id, itemId) => { const it = db.items.find((i) => i.id === itemId); if (it) it.done = 1; return !!it; },
  deletePersonalItem: async (ch, id, itemId) => { const b = db.items.length; db.items = db.items.filter((i) => i.id !== itemId); return b !== db.items.length; },
};

const Module = require('module');
const orig = Module.prototype.require;
Module.prototype.require = function (id) {
  if (id === '../services/mysql') return mysqlMock;
  return orig.apply(this, arguments);
};
const facts = require('../../src/tools/rememberFact');
const personal = require('../../src/tools/personalItems');
Module.prototype.require = orig;

const ctx = { channel: 'whatsapp', chatId: '77770000001' };
const byName = (mod, name) => mod.tools.find((t) => t.definition.function.name === name);

describe('память-факты', () => {
  test('remember → list → forget, дедуп', async () => {
    db.facts = []; db.nextId = 1;
    const remember = byName(facts, 'remember_fact');
    const r1 = await remember.handler({ fact: 'Не работает по пятницам', category: 'предпочтение' }, ctx);
    assert.equal(r1.success, true);
    assert.equal(r1.duplicate, false);
    const dup = await remember.handler({ fact: 'не работает по пятницам' }, ctx); // та же норма
    assert.equal(dup.duplicate, true);
    const list = await byName(facts, 'list_facts').handler({}, ctx);
    assert.equal(list.count, 1);
    const forget = await byName(facts, 'forget_fact').handler({ match: 'пятниц' }, ctx);
    assert.equal(forget.deleted, 1);
    assert.equal((await byName(facts, 'list_facts').handler({}, ctx)).count, 0);
  });

  test('глобальное правило: scope=global, помечено как общее, видно в list', async () => {
    db.facts = []; db.nextId = 1;
    const remember = byName(facts, 'remember_fact');
    const g = await remember.handler({ fact: 'Со всеми сотрудниками общаться коротко и по делу', scope: 'global' }, ctx);
    assert.equal(g.success, true);
    assert.equal(g.scope, 'global');
    assert.match(g.note, /общее правило|для всех/i);
    const p = await remember.handler({ fact: 'Любит кофе' }, ctx); // personal по умолчанию
    assert.equal(p.scope, 'personal');
    const list = await byName(facts, 'list_facts').handler({}, ctx);
    assert.equal(list.count, 2);
    const glob = list.facts.find((f) => f.scope === 'global');
    assert.ok(glob && /коротко/.test(glob.fact));
  });
});

describe('заметки', () => {
  test('add/list/delete', async () => {
    db.items = []; db.nextId = 1;
    const notes = byName(personal, 'manage_notes');
    const a = await notes.handler({ action: 'add', text: 'идея: новый лоток' }, ctx);
    assert.equal(a.success, true);
    const l = await notes.handler({ action: 'list' }, ctx);
    assert.equal(l.count, 1);
    assert.match(l.notes[0].text, /лоток/);
    const d = await notes.handler({ action: 'delete', id: a.id }, ctx);
    assert.equal(d.success, true);
  });
});

describe('задачи', () => {
  test('add с due (локальное→UTC), list, done', async () => {
    db.items = []; db.nextId = 1;
    const todos = byName(personal, 'manage_todos');
    const a = await todos.handler({ action: 'add', text: 'купить SIM', due: '2030-01-01 10:00' }, ctx);
    assert.equal(a.success, true);
    // due_local показывается локально (10:00); в БД ушло UTC (05:00) — проверим, что хранится сдвиг
    assert.match(a.due_local, /2030-01-01 10:00/);
    assert.equal(db.items[0].due, '2030-01-01 05:00:00');
    const l = await todos.handler({ action: 'list' }, ctx);
    assert.equal(l.count, 1);
    assert.equal(l.todos[0].done, false);
    const done = await todos.handler({ action: 'done', id: a.id }, ctx);
    assert.equal(done.success, true);
    assert.equal((await todos.handler({ action: 'list' }, ctx)).count, 0); // выполненные скрыты
  });

  test('due в кривом формате → ошибка', async () => {
    const todos = byName(personal, 'manage_todos');
    const r = await todos.handler({ action: 'add', text: 'x', due: 'завтра' }, ctx);
    assert.equal(r.success, false);
    assert.match(r.message, /due/);
  });
});

'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { isSilentStub } = require('../../src/utils/silentStub');

describe('isSilentStub — глушим самонарратив по расписанию', () => {
  test('глушит «Пустой ответ — напоминание отправлено» (жалоба босса)', () => {
    assert.equal(isSilentStub('Пустой ответ - напоминание отправлено'), true);
    assert.equal(isSilentStub('пустой ответ'), true);
    assert.equal(isSilentStub('Ответ пустой.'), true);
  });

  test('глушит короткие отписки и маркеры отправки', () => {
    for (const s of ['✅ Проверено', 'Всё ок', 'всё в порядке', 'Готово', 'Ок',
      'напоминание отправлено', 'Отправлено сотруднику Курбану', 'Без изменений']) {
      assert.equal(isSilentStub(s), true, s);
    }
  });

  test('НЕ глушит реальные напоминания/сообщения', () => {
    for (const s of [
      'Позвони Курбану по оплате ЖК Шабыт',
      'Готов план по объекту, 5 задач — на утверждение',
      'Напоминаю: завтра отгрузка лотков ДН200, проверь зелёнку',
      'Остаток ДН200 — 239 шт',
    ]) {
      assert.equal(isSilentStub(s), false, s);
    }
  });

  test('пустая строка — не стаб (обрабатывается отдельно)', () => {
    assert.equal(isSilentStub(''), false);
    assert.equal(isSilentStub('   '), false);
  });
});

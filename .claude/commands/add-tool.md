---
description: Создать новый инструмент агента в src/tools/ по канону tool registry
---

Ты добавляешь новый инструмент в AI Bot Core. Инструменты подключаются через registry
(`src/tools/index.js`): один файл в `src/tools/` = один инструмент, автозагрузка. Тебе НЕ нужно
править `agent.js`, `index.js` или какой-либо общий список — только создать новый файл.

## Описание инструмента от пользователя

$ARGUMENTS

## Что сделать

1. Если описание неполное (непонятно имя, параметры, или что именно делает handler — например к
   какому API/БД он ходит) — задай уточняющие вопросы ПЕРЕД написанием кода. Не выдумывай интеграции.
2. Изучи эталон `src/tools/exampleEcho.js` и контракт в `AGENTS.md` (раздел «Рецепт: добавить инструмент»).
3. Создай файл `src/tools/<имя>.js`, экспортирующий `{ definition, handler }`:
   - `definition.function.name` — уникальное `snake_case` имя (проверь, что такого ещё нет:
     `node -e "console.log(require('./src/tools').tools.map(t=>t.function.name))"`).
   - `definition.function.description` — что делает И когда модели его звать.
   - `definition.function.parameters` — JSON Schema аргументов (`type:'object'`, `properties`, `required`).
   - `handler(args, context)` — async, `context = { channel, chatId, phone, clientName }`. Возвращает
     сериализуемый объект (он уйдёт модели как результат). Оборачивай внешние вызовы в try/catch и
     возвращай `{ success:false, message:'...' }` при ошибке.
4. Не клади секреты в код — только через `process.env` / `src/config.js`.

## Проверка (обязательно)

```bash
node --check src/tools/<имя>.js
node -e "console.log(require('./src/tools').tools.map(t=>t.function.name))"   # новый инструмент в списке
node --test                                                                   # тесты зелёные
```

Покажи пользователю созданный файл и подтверди, что инструмент зарегистрировался.

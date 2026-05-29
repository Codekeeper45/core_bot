# AGENTS.md — инструкция для AI-агентов (Claude Code и др.)

Этот файл читают AI-агенты, работающие с репозиторием. Здесь — что это за проект,
жёсткие архитектурные инварианты и точные рецепты типовых задач. Следуй им буквально,
чтобы изменения встраивались в ядро без поломок.

## Что это

**AI Bot Core** — переиспользуемое ядро AI-бота для мессенджеров. Назначение: быстро
собрать бота под любой бизнес. Инфраструктура (3 канала, агентный цикл, память, медиа,
handoff, привязка WhatsApp) уже готова — задача агента обычно сводится к: сменить персону +
добавить инструменты под предметную область.

Стек: Node.js (CommonJS), Express, OpenAI SDK → OpenRouter/DeepSeek, MySQL, Baileys (WhatsApp),
Telegraf (Telegram), Wazzup24 (Instagram).

## Жёсткие инварианты (НЕ нарушать)

1. **Инструменты — только через registry.** Один инструмент = один файл в `src/tools/`,
   экспортирующий `{ definition, handler }`. НИКОГДА не правь `src/agent/agent.js` или
   какой-то общий список ради нового инструмента — registry (`src/tools/index.js`) находит
   файлы автоматически.
2. **Ответы бота — plain text, без Markdown.** Мессенджеры коверкают `*`, `#`, ``` ``` ```.
   Это правило закреплено в системном промпте — не вводи Markdown в ответы модели.
3. **Не клади секреты в код и git.** Всё через `.env` (см. `.env.example`). `.env` и
   `auth_info_baileys/` — в `.gitignore`, не коммить их.
4. **Не ломай рабочее ядро.** После изменений прогоняй `node --test` (должно быть зелено) и
   `node --check` по затронутым файлам.
5. **Бизнес-логику держи в инструментах**, а не в конвейере `index.js` и не в middleware.

## Карта проекта

```
src/
  index.js            конвейер сообщений + HTTP (/health, /pair, webhooks)  — НЕ трогать без нужды
  config.js           вся конфигурация из ENV
  agent/agent.js      агентный цикл + LLM fallback                          — НЕ трогать ради инструментов
  agent/prompts/system_prompt.txt   ПЕРСОНА бота (правь здесь)
  agent/systemPrompt.js             сборка промпта + контекст пользователя
  tools/index.js      registry (автозагрузка инструментов)                  — трогать только для смены контракта
  tools/<name>.js      ← СЮДА добавляются инструменты (1 файл = 1 инструмент)
  tools/exampleEcho.js  ПРИМЕР формата (можно удалить)
  channels/           normalize + whatsapp/telegram/instagram
  media/              voice (STT), image (Vision), document
  middleware/         buffer, concurrency, rateLimit, deduplication, handoff, typing
  services/           baileys, mysql, wazzup, tunnel, openrouterMedia
```

## Рецепт: добавить инструмент

Создай ОДИН файл `src/tools/<имя>.js` по шаблону (см. также `src/tools/exampleEcho.js`):

```js
'use strict';

const definition = {
  type: 'function',
  function: {
    name: 'create_order',                       // уникальное snake_case имя
    description: 'Что делает инструмент и КОГДА его звать (для модели).',
    parameters: {
      type: 'object',
      properties: {
        item: { type: 'string', description: 'Что заказать' },
        qty:  { type: 'number', description: 'Количество' },
      },
      required: ['item'],
    },
  },
};

// context = { channel, chatId, phone, clientName }
async function handler(args, context) {
  // ... твоя логика (вызов API, запись в БД и т.п.)
  // верни сериализуемый объект — он уйдёт модели как результат инструмента
  return { success: true, order_id: 123 };
}

module.exports = { definition, handler };
```

Больше ничего править не нужно. Зарегистрируется автоматически. Проверь:
`node -e "console.log(require('./src/tools').tools.map(t=>t.function.name))"`.

В Claude Code для этого есть slash-команда **`/add-tool`** — опиши инструмент словами,
она сгенерирует файл по канону.

## Рецепт: сменить персону/задачу бота

Перепиши `src/agent/prompts/system_prompt.txt` под свою роль. Сохрани правила про plain-text,
краткость и про инструмент `notify_manager` (когда передавать диалог человеку). Контекст
пользователя (имя/телефон/канал) добавляется автоматически в `systemPrompt.js`.

## Рецепт: новый канал

Маловероятно нужен (3 уже есть). Если да: адаптер в `src/channels/`, ветка в
`normalizeInbound` (`channels/normalize.js`) и в `sendReply()` (`src/index.js`).

## Проверка после изменений

```bash
node --test                                   # все тесты зелёные
node -e "require('./src/tools')"              # registry грузится без ошибок
node --check src/<изменённый>.js              # синтаксис
```

# CLAUDE.md

Guidance for Claude Code (and humans) working in this repository.

## What This Is

**AI Bot Core** — минимальное переиспользуемое ядро AI-бота. Один агентный цикл с tool-calling
поверх LLM, три канала связи (WhatsApp через Baileys, Telegram через Telegraf, Instagram через
Wazzup24) и один инструмент — передача диалога живому менеджеру (`notify_manager`).

Ядро намеренно нейтральное: никакой привязки к компании, отрасли, скоринга или CRM. Это шаблон,
на котором собираются конкретные боты — меняешь промпт, добавляешь инструменты, и готово.

LLM-движок — OpenAI-совместимый: OpenRouter (по умолчанию) и/или DeepSeek (опционально, как
основной провайдер с fallback на OpenRouter).

## Commands

```bash
node src/index.js     # запустить бота
npm start             # то же самое
node --test tests/    # все тесты (встроенный test-runner Node, без Jest)
node --test tests/normalize.test.js   # один файл
```

Сборки нет — обычный Node.js CommonJS.

## Architecture

### Message pipeline (`src/index.js`)

Каждое входящее сообщение проходит последовательно:

1. **Normalize** (`channels/normalize.js`) — единый `{channel, chat_id, phone, message_type, ...}`
   для WA / TG / IG.
2. **Media preprocessing** — голос → STT-транскрипт, изображение → анализ через Vision,
   документ → извлечённый текст (`media/`).
3. **Buffer** (`middleware/buffer.js`) — склейка быстрых сообщений в один батч (~1с окно).
4. **Handoff check** (`middleware/handoff.js`) — если менеджер взял диалог, бот молчит.
5. **Rate limit + dedup** (`middleware/`) — в памяти, до взятия блокировки.
6. **Concurrency lock** (`middleware/concurrency.js`) — один активный запрос на чат, остальное в очередь.
7. **Image analysis** — Vision через OpenRouter для буферизованных изображений.
8. **AI Agent** (`agent/agent.js`) — агентный цикл с вызовом инструментов, до `AI_MAX_ITERATIONS`.
9. **Send reply** — обратно через исходный канал.

### AI agent loop (`src/agent/agent.js`)

- OpenAI SDK, нацеленный на OpenRouter (`https://openrouter.ai/api/v1`) и/или DeepSeek.
- Провайдер-цепочка с fallback: DeepSeek → OpenRouter primary → OpenRouter backup, у каждого ретраи.
- Грузит историю чата из MySQL, зовёт LLM с системным промптом + инструментами, обрабатывает
  `tool_calls` в цикле через `executeToolCall()`.
- При переполнении истории сворачивает старую часть в сводку (`agent/contextManager.js`).

### Tools (`src/tools/`)

| Tool | File | Назначение |
|---|---|---|
| `notify_manager` | `tools/notifyManager.js` | Передать диалог менеджеру (WA-группа/личка + Telegram + ссылка на IG-профиль), поставить бота на паузу (handoff). |

Схемы инструментов — в `agent/toolDefinitions.js`, диспетчеризация — в `executeToolCall()`
внутри `agent/agent.js`.

### Channels (`src/channels/` + `src/services/`)

- `normalize.js` — единая точка нормализации входящих апдейтов Baileys / Telegraf / Wazzup.
- `whatsapp.js` + `services/baileys.js` — WhatsApp (WebSocket, pairing через `/pair`).
- `telegram.js` — Telegram (Telegraf, polling или webhook).
- `instagram.js` + `services/wazzup.js` + `services/wazzupPoll.js` — Instagram Direct через Wazzup24.

### Persistence (`src/services/mysql.js`)

MySQL, 4 таблицы (создаются на старте в `initTables()`):

- `bot_chat_history` — история диалога + сжатая сводка.
- `bot_handoff_state` — состояние паузы (менеджер взял диалог), с TTL.
- `bot_handoff_history` — сообщения, пришедшие пока бот на паузе.
- `bot_daily_counts` — дневные лимиты изображений/документов.

### System prompt (`src/agent/prompts/system_prompt.txt`, `src/agent/systemPrompt.js`)

Нейтральный промпт «AI-консультант, который помогает пользователям и умеет вызывать инструменты».
В рантайме к нему добавляется только имя/телефон/канал пользователя.

## Key constants (`src/config.js`)

```
BUFFER_WAIT: 1000ms        — окно склейки сообщений
AI_MAX_ITERATIONS: 20      — макс. раундов вызова инструментов за запрос
CHAT_MEMORY_WINDOW: 100    — сколько сообщений грузим из MySQL
CONTEXT_SUMMARY_CHAR_LIMIT — порог сворачивания истории в сводку
HANDOFF_TTL: 600s          — сколько держится пауза менеджера
DAILY_IMAGE_LIMIT / DAILY_DOC_LIMIT: 10
```

## Environment Variables

| Variable | Назначение |
|---|---|
| `OPENROUTER_API_KEY` | LLM + STT + Vision через OpenRouter (обязателен) |
| `OPENROUTER_MODEL` / `OPENROUTER_FALLBACK_MODEL` | Модели OpenRouter |
| `DEEPSEEK_API_KEY` / `DEEPSEEK_MODEL` | Опц. основной текстовый провайдер с fallback на OpenRouter |
| `MYSQL_HOST/PORT/DATABASE/USER/PASSWORD` | MySQL (обязателен) |
| `TELEGRAM_BOT_TOKEN` | Токен Telegram-бота |
| `TELEGRAM_WEBHOOK_URL` | Если задан — webhook вместо polling |
| `WA_AUTH_DIR` / `WA_PAIRING_PHONE` / `PAIR_TOKEN` / `ENABLE_TUNNEL` | WhatsApp (Baileys) и pairing-страница |
| `WAZZUP_API_KEY` / `WAZZUP_WEBHOOK_SECRET` / `WAZZUP_WORKER_URL` / `WAZZUP_IG_CHANNEL_ID` | Instagram через Wazzup24 |
| `MANAGER_WA` / `MANAGER_GROUP_WA` / `MANAGER_TG` / `MANAGER_NAME` / `MANAGER_PUBLIC_CONTACT` | Куда уведомлять менеджера |
| `BOT_NAME` | Имя бота в уведомлениях менеджеру |
| `BLOCKED_PHONES` / `EXCLUDED_CHAT_ID` | Игнор-листы |

Минимум для старта: `OPENROUTER_API_KEY`, `MYSQL_*`, `TELEGRAM_BOT_TOKEN`.

## Extension points — как собрать своего бота

1. **Поведение/личность** → отредактируй `src/agent/prompts/system_prompt.txt`.
2. **Новый инструмент** → добавь схему в `agent/toolDefinitions.js`, обработай `case` в
   `executeToolCall()` (`agent/agent.js`), при необходимости создай файл в `src/tools/`.
3. **Новый канал** → адаптер в `src/channels/` + ветка в `normalize.js` и `sendReply()`.
4. **Модель/провайдер** → через env (`OPENROUTER_MODEL`, `DEEPSEEK_*`); код менять не нужно.

## Tests

Тесты в `tests/`, встроенный `node:test`. Покрывают нормализацию каналов, контекст-менеджер,
сборку промпта, LLM-fallback, санитайзер вывода и `notify_manager`.

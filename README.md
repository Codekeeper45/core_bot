# AI Bot Core

Минимальное, переиспользуемое ядро AI-бота для мессенджеров. Один агентный цикл с вызовом инструментов (tool-calling) поверх LLM, три канала связи и чистая модульная архитектура — шаблон, на котором собираются конкретные боты под любую задачу.

> Нейтральное ядро без привязки к компании, отрасли или CRM. Меняете системный промпт, добавляете инструменты — и получаете своего бота.

---

## Содержание

- [Возможности](#возможности)
- [Архитектура](#архитектура)
- [Быстрый старт](#быстрый-старт)
- [Переменные окружения](#переменные-окружения)
- [Подключение каналов](#подключение-каналов)
  - [Telegram](#telegram)
  - [WhatsApp + ссылка для привязки](#whatsapp--ссылка-для-привязки)
  - [Instagram (Wazzup24)](#instagram-wazzup24)
- [Технические детали возможностей](#технические-детали-возможностей)
- [Расширение ядра](#расширение-ядра)
- [Эксплуатация](#эксплуатация)
- [Тесты](#тесты)
- [FAQ](#faq)

---

## Возможности

| Возможность | Кратко |
|---|---|
| **3 канала** | WhatsApp (Baileys), Telegram (Telegraf), Instagram Direct (Wazzup24) — единый формат сообщений |
| **AI-агент** | Агентный цикл с tool-calling, до 20 итераций, цепочка LLM-провайдеров с fallback |
| **Память** | История диалога в MySQL + автоматическое сжатие старого контекста в сводку |
| **Мультимодальность** | Голос → текст (STT), изображения → описание (Vision), документы → текст (PDF/DOCX/XLSX/TXT) |
| **Передача менеджеру** | Инструмент `notify_manager`: уведомление + пауза бота (handoff) |
| **Защита пайплайна** | Буфер сообщений, concurrency-lock, rate-limit, дедупликация |
| **Удалённая привязка WhatsApp** | Веб-страница `/pair` (QR + код) через HTTPS-туннель — без доступа к серверу |
| **Управление** | Команды `/pause` и `/resume`, эндпоинт `/health` с метриками |

---

## Архитектура

Каждое входящее сообщение проходит последовательный конвейер (`src/index.js`):

```
Входящее (WA / TG / IG)
        │
        ▼
1. normalize      → единый объект {channel, chat_id, phone, message_type, ...}
2. media          → голос→STT, изображение→Vision, документ→текст
3. buffer         → склейка быстрых сообщений (~1с)
4. handoff        → если менеджер на линии — бот молчит
5. rate-limit     → ≤10 сообщений/мин на чат
6. dedup          → гасит повторы webhook'ов
7. concurrency    → один запрос на чат, остальное в очередь
8. AI-агент       → LLM + tool-calling (notify_manager)
9. sendReply      → ответ обратно в исходный канал
```

### Структура проекта

```
src/
├── index.js              оркестратор конвейера + HTTP-сервер (/health, /pair, webhooks)
├── config.js             вся конфигурация из ENV
├── agent/
│   ├── agent.js          агентный цикл, цепочка LLM-провайдеров, fallback
│   ├── contextManager.js сжатие истории в сводку (долгая память)
│   ├── memory.js         чтение/запись истории в MySQL
│   ├── systemPrompt.js   сборка системного промпта + контекст пользователя
│   └── prompts/
│       └── system_prompt.txt   текст системного промпта (личность бота)
├── channels/
│   ├── normalize.js      нормализация входящих WA/TG/IG → единый формат
│   ├── whatsapp.js       отправка в WhatsApp
│   ├── telegram.js       Telegraf-бот + отправка (авто-split длинных сообщений)
│   └── instagram.js      отправка в Instagram через Wazzup
├── media/
│   ├── voice.js          скачивание + STT-транскрипция
│   ├── image.js          Vision-анализ изображений + дневной лимит
│   └── document.js       извлечение текста из PDF/DOCX/XLSX/TXT
├── middleware/
│   ├── buffer.js         склейка сообщений
│   ├── concurrency.js    per-chat lock + очередь
│   ├── deduplication.js  фильтр повторов
│   ├── handoff.js        пауза при передаче менеджеру
│   ├── rateLimit.js      ограничение частоты
│   └── typing.js         индикатор «печатает…»
├── routes/
│   └── pair.js           веб-страница привязки WhatsApp (/pair)
├── services/
│   ├── baileys.js        WhatsApp WebSocket-клиент (Baileys)
│   ├── mysql.js          пул соединений + 4 таблицы
│   ├── wazzup.js         Wazzup24 REST API (Instagram)
│   ├── wazzupPoll.js     поллинг очереди Worker'а
│   ├── openrouterMedia.js STT + Vision через OpenRouter
│   └── tunnel.js         Cloudflare Quick Tunnel для HTTPS
├── tools/                инструменты агента — 1 файл = 1 инструмент (автозагрузка)
│   ├── index.js          registry: сканирует папку, собирает tools + executeToolCall
│   ├── notifyManager.js  передача диалога менеджеру + handoff
│   └── exampleEcho.js    пример формата инструмента (можно удалить)
├── security/
│   └── sanitizer.js      срезка Markdown + маскировка PII
└── utils/                helpers, logger, piiMask, retry
```

---

## Быстрый старт

### Требования

- **Node.js** ≥ 18
- **MySQL** 5.7+ / 8.x (любой доступный сервер)
- API-ключ **OpenRouter** (LLM + STT + Vision)
- Токен **Telegram-бота** и/или привязка WhatsApp / Instagram

### Установка

```bash
git clone https://github.com/Codekeeper45/core_bot.git
cd core_bot
npm install        # cloudflared подтянет бинарник (~30 МБ) при необходимости
cp .env.example .env
```

Заполните минимум в `.env`:

```bash
OPENROUTER_API_KEY=sk-or-...        # ключ OpenRouter
MYSQL_HOST=localhost
MYSQL_DATABASE=botdb
MYSQL_USER=botuser
MYSQL_PASSWORD=...
TELEGRAM_BOT_TOKEN=123456:ABC...    # хотя бы один канал
```

### Запуск

```bash
npm start
# или
node src/index.js
```

При старте бот:
1. Создаёт 4 таблицы в MySQL (если их нет).
2. Поднимает Telegram (polling или webhook).
3. Подключается к WhatsApp (если есть сессия) или ждёт привязки.
4. Регистрирует Wazzup-webhook (если настроен).
5. Поднимает HTTP-сервер: `GET /health`, страница `/pair`.

Проверка: `curl http://localhost:3000/health` → `{"status":"ok", "mysql":"connected", ...}`.

### Запуск через Docker (с MySQL «из коробки»)

Не нужно поднимать MySQL вручную — `docker compose` поднимет бота вместе с базой:

```bash
cp .env.example .env     # заполните OPENROUTER_API_KEY и токены каналов;
                         # MYSQL_HOST оставьте = mysql (имя сервиса в compose)
docker compose up --build
```

Сессия WhatsApp (`auth_info_baileys/`) и данные MySQL сохраняются в volume и переживают рестарт.

---

## Переменные окружения

Полный список — в [`.env.example`](.env.example). Главное:

### Обязательные

| Переменная | Назначение |
|---|---|
| `OPENROUTER_API_KEY` | LLM + STT + Vision через OpenRouter |
| `MYSQL_HOST` / `MYSQL_PORT` / `MYSQL_DATABASE` / `MYSQL_USER` / `MYSQL_PASSWORD` | Подключение к MySQL |

> Без MySQL-переменных бот намеренно падает на старте с понятной ошибкой `Missing required MySQL env vars` — это валидация, а не баг.

### LLM

| Переменная | По умолчанию | Назначение |
|---|---|---|
| `OPENROUTER_MODEL` | `deepseek/deepseek-v4-flash` | Основная модель OpenRouter |
| `OPENROUTER_FALLBACK_MODEL` | — | Резервная модель (если основная упала) |
| `DEEPSEEK_API_KEY` | — | Опц. прямой DeepSeek как основной провайдер (OpenRouter становится fallback) |
| `DEEPSEEK_BASE_URL` | `https://api.deepseek.com` | |
| `DEEPSEEK_MODEL` | `deepseek-chat` | |

### Каналы

| Переменная | Назначение |
|---|---|
| `TELEGRAM_BOT_TOKEN` | Токен от @BotFather |
| `TELEGRAM_WEBHOOK_URL` | Если задан — webhook вместо polling |
| `WA_AUTH_DIR` | Папка сессии WhatsApp (по умолч. `auth_info_baileys`) |
| `WA_PAIRING_PHONE` | Номер для pairing-кода (только цифры) |
| `PAIR_TOKEN` | Секрет для доступа к странице `/pair` (16+ символов) |
| `ENABLE_TUNNEL` | `1` — поднять Cloudflare Quick Tunnel для HTTPS |
| `WAZZUP_API_KEY` / `WAZZUP_WEBHOOK_SECRET` / `WAZZUP_WORKER_URL` / `WAZZUP_IG_CHANNEL_ID` | Instagram через Wazzup24 |

### Менеджер и прочее

| Переменная | Назначение |
|---|---|
| `BOT_NAME` | Имя бота в уведомлениях менеджеру |
| `MANAGER_WA` / `MANAGER_GROUP_WA` / `MANAGER_TG` | Куда слать уведомления о передаче диалога |
| `MANAGER_NAME` / `MANAGER_PUBLIC_CONTACT` | Имя менеджера и публичный контакт для клиента |
| `BLOCKED_PHONES` / `EXCLUDED_CHAT_ID` | Игнор-листы |
| `PORT` | Порт HTTP-сервера (по умолч. `3000`) |

---

## Подключение каналов

### Telegram

1. Создайте бота у [@BotFather](https://t.me/BotFather) → получите токен.
2. Впишите `TELEGRAM_BOT_TOKEN=...` в `.env`.
3. Запустите бота — по умолчанию работает **long polling**, сразу готов отвечать.
4. (Опц.) Для webhook задайте `TELEGRAM_WEBHOOK_URL=https://ваш-домен.com` — бот сам зарегистрирует `POST /webhook/telegram`.

### WhatsApp + ссылка для привязки

WhatsApp работает через [Baileys](https://github.com/WhiskeySockets/Baileys) (неофициальный WebSocket-клиент). Привязка — двумя способами.

#### Вариант А — локально (есть доступ к серверу)

Запустите бота: в консоли появится QR-код. Отсканируйте его в **WhatsApp → Связанные устройства → Привязать устройство**. Сессия сохранится в `auth_info_baileys/` и переживёт рестарт.

#### Вариант Б — удалённая ссылка (заказчик привязывает сам)

Это и есть фишка `/pair` — публичная HTTPS-страница, через которую кто угодно привяжет свой WhatsApp без доступа к серверу.

**Как сделать ссылку:**

1. Сгенерируйте секретный токен и включите туннель в `.env`:
   ```bash
   PAIR_TOKEN=$(openssl rand -hex 16)   # любая случайная строка 16+ символов
   ENABLE_TUNNEL=1
   ```
2. Запустите бота. В логах через ~10 секунд появится:
   ```
   [Tunnel] ✅ HTTPS: https://random-words.trycloudflare.com
   [Tunnel] PAIR PAGE: https://random-words.trycloudflare.com/pair?token=ВАШ_ТОКЕН
   ```
3. Отправьте эту **PAIR PAGE** ссылку заказчику любым мессенджером.
4. На странице заказчик выбирает один из способов:
   - **Код из 8 цифр** — вводит свой номер → получает код → в WhatsApp: *Связанные устройства → Привязать → Привязать по номеру телефона* → вводит код.
   - **QR** — открывает страницу на втором устройстве и сканирует основным телефоном.
5. Через 3–5 секунд страница сама показывает «✓ Бот подключён к +XXXX». Сессия сохранена.

> **Почему именно так:** мобильные браузеры (Chrome Mobile, HTTPS-Only) блокируют HTTP-сайты, а сотовые операторы — нестандартные порты. Cloudflare Quick Tunnel даёт валидный HTTPS-URL без своего домена и сертификата. Подробности и подводные камни Baileys 7.x — в разделе [технических деталей](#5-веб-страница-привязки-pair).

> **Безопасность:** без `PAIR_TOKEN` страница отдаёт `503` (выключена). С неверным токеном — `403`. Туннель в проде лучше заменить на собственный домен.

### Instagram (Wazzup24)

Instagram Direct идёт не через официальный API, а через платформу-агрегатор [Wazzup24](https://wazzup24.com).

1. В Wazzup подключите Instagram-канал, получите `WAZZUP_API_KEY` и ID канала (`WAZZUP_IG_CHANNEL_ID`).
2. Сгенерируйте секрет вебхука: `openssl rand -hex 32` → `WAZZUP_WEBHOOK_SECRET`.
3. Вебхук должен указывать на `https://<хост>/webhook/wazzup/<секрет>`.
   - Простой путь: задайте `WAZZUP_WEBHOOK_BASE_URL=https://ваш-домен.com` — бот зарегистрирует вебхук сам.
   - Если Wazzup блокирует ваш хост (например `*.trycloudflare.com`) — поднимите прокси из [`cloudflare-worker/`](cloudflare-worker/README.md) и задайте `WAZZUP_WORKER_URL`.
4. Запустите бота — он зарегистрирует вебхук и начнёт принимать сообщения.

---

## Технические детали возможностей

### 1. AI-агент (`src/agent/agent.js`)

Ядро мышления — агентный цикл поверх OpenAI-совместимого API.

- **Цепочка провайдеров с fallback.** Порядок: DeepSeek (если задан `DEEPSEEK_API_KEY`) → основная модель OpenRouter → резервная модель OpenRouter. У каждого провайдера 3 повтора с экспоненциальной задержкой; при полном отказе — переход к следующему.
- **Цикл tool-calling.** На каждой итерации модель получает системный промпт + историю + схемы инструментов (`tool_choice: 'auto'`). Если она возвращает `tool_calls` — инструменты выполняются, результат возвращается модели, цикл продолжается. До `AI_MAX_ITERATIONS` (20) раундов.
- **Подстраховки.** Если за 20 итераций нет текстового ответа — финальный вызов с `tool_choice: 'none'`. Если LLM недоступен после всех повторов — бот автоматически вызывает `notify_manager` (эскалация на человека) и извиняется перед пользователем.
- **Метрики.** Объект `agentMetrics` считает `total / success / llm_error / loop_exhausted / fallback_recovered / empty_reply / unexpected_error / fallback_model_used` — отдаётся в `/health`.

### 2. Память и контекст (`memory.js`, `contextManager.js`)

- **Хранилище.** История диалога — в таблице `bot_chat_history` (формат OpenAI-сообщений), до `CHAT_MEMORY_WINDOW` (100) последних.
- **Долгая память.** Когда суммарный объём истории превышает `CONTEXT_SUMMARY_CHAR_LIMIT` (по умолч. 50000 символов), старая часть сжимается LLM в структурированную сводку (ФАКТЫ / КОНТЕКСТ / РЕШЕНИЯ / ХОД БЕСЕДЫ / СТАТУС), последние `CONTEXT_KEEP_RECENT_MSGS` (20) сообщений остаются дословно. Точка разреза выбирается так, чтобы не разорвать пару «вызов инструмента → результат» (иначе API отвергнет запрос). Сбой свёртки не блокирует ответ — возвращается исходный контекст.

### 3. Каналы и нормализация (`channels/`)

- **`normalize.js`** приводит сырой апдейт любого канала к единому объекту: `channel`, `chat_id`, `phone`, `client_name`, `message`, `message_type` (`text`/`voice`/`image`/`document`), флаги `is_private` / `is_supported` и т.д. Дальше код не различает источник.
- **Telegram** (`telegram.js`): Telegraf, polling или webhook, авто-разбивка ответов >4096 символов по абзацам/предложениям.
- **WhatsApp** (`whatsapp.js` + `services/baileys.js`): личка и группы, извлечение номера из JID, скачивание зашифрованных медиа.
- **Instagram** (`instagram.js` + `services/wazzup.js`): идентификация по username (телефона нет), авто-split, кэш ID активного канала.

### 4. Мультимодальность (`media/`)

| Тип | Пайплайн | Лимит |
|---|---|---|
| **Голос** | скачивание → STT (OpenRouter, модель `google/chirp-3`) → текст | — |
| **Изображения** | скачивание → Vision (`google/gemini-3.1-flash-lite`) → описание + текст | 10/день на чат |
| **Документы** | PDF (`pdf-parse`), DOC/DOCX (`mammoth`), XLSX (`xlsx`→CSV), TXT | 10/день, до `DOCUMENT_CHAR_LIMIT` (20000) символов |

Видео, гео, стикеры, vCard → вежливая заглушка, агент не вызывается. STT/Vision всегда идут через OpenRouter (у DeepSeek их нет).

### 5. Веб-страница привязки `/pair` (`routes/pair.js`)

- **Эндпоинты** (все за middleware-проверкой токена): `GET /pair` (HTML), `GET /pair/qr.png` (PNG QR), `POST /pair/code` (запрос 8-значного кода), `GET /pair/status` (статус для polling'а страницы).
- **Страница** — тёмная, mobile-first, без внешних зависимостей. Два способа привязки, авто-обновление QR каждые 10 сек, обратный отсчёт кода, авто-определение подключения каждые 3 сек.
- **Критичные нюансы Baileys 7.x** (зашиты в `baileys.js`):
  - `browser: Browsers.macOS('Chrome')` — обязательно. С `Desktop`/`Safari` WA-сервер не создаёт pending pairing, и привязка по коду не работает.
  - Перед `requestPairingCode` ждём готовности WebSocket (до 8 сек) + один повтор через 1.5 сек — иначе код генерируется локально, но сервер о нём не знает.
- **HTTPS** через Cloudflare Quick Tunnel (`services/tunnel.js`): lazy-загрузка бинарника, авто-рестарт туннеля при падении.

### 6. Передача менеджеру (`tools/notifyManager.js`)

Единственный встроенный инструмент агента:
- шлёт уведомление в **WhatsApp** (группа приоритетнее лички) + **Telegram**; для Instagram — ссылку на профиль клиента;
- активирует **handoff** — пишет в `bot_handoff_state` с TTL `HANDOFF_TTL` (600с). Пока активен, `middleware/handoff.js` глушит бота и копит входящие в `bot_handoff_history`; при снятии паузы они отдаются агенту как «история во время паузы»;
- возвращает клиенту заготовленный `client_message`.

### 7. Middleware (`middleware/`)

| Модуль | Логика |
|---|---|
| `buffer.js` | копит сообщения `BUFFER_WAIT` (1000мс), склеивает в один запрос; если пришло новое — ждёт его |
| `concurrency.js` | per-chat lock; занято → в очередь, освободился → следующий через `setImmediate` |
| `rateLimit.js` | окно 60с, максимум 10 сообщений на чат; авто-очистка простаивающих чатов |
| `deduplication.js` | LRU-кэш на 90с по `channel:chat_id:content` |
| `handoff.js` | проверка паузы менеджера, накопление/возврат истории |
| `typing.js` | «печатает…» каждые `TYPING_INTERVAL` (4000мс), пока агент думает |

### 8. Хранилище (`services/mysql.js`)

Пул `mysql2/promise` + 4 таблицы, создаются на старте:

| Таблица | Назначение |
|---|---|
| `bot_chat_history` | история диалога + сводка |
| `bot_handoff_state` | состояние паузы (TTL) |
| `bot_handoff_history` | сообщения, пришедшие во время паузы |
| `bot_daily_counts` | дневные счётчики изображений/документов |

### 9. Безопасность (`security/sanitizer.js`)

- `sanitizeReply` — срезает Markdown (мессенджеры его коверкают) и маскирует номера карт в исходящих.
- `sanitizeLog` — маскирует телефоны и карты в логах.
- Страница `/pair` отдаёт CSP, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`.

---

## Расширение ядра

Ядро — это **фреймворк**: на нём быстро собирается бот под любую задачу. Подробные гайды:
- **[EXTENDING.md](EXTENDING.md)** — «создай своего бота» пошагово (персона → инструменты → каналы).
- **[AGENTS.md](AGENTS.md)** — инструкция для AI-агентов (Claude Code): инварианты и рецепты.

Четыре точки расширения:

1. **Поведение / личность бота** → отредактируйте `src/agent/prompts/system_prompt.txt`.
2. **Новый инструмент** → создайте **один файл** в `src/tools/`. Registry (`src/tools/index.js`)
   подхватит его автоматически — `agent.js` и другие файлы править НЕ нужно.
3. **Новый канал** → адаптер в `src/channels/` + ветка в `normalize.js` и `sendReply()`.
4. **Модель / провайдер** → через `.env` (`OPENROUTER_MODEL`, `DEEPSEEK_*`); код менять не нужно.

### Tool registry: добавить инструмент = один файл

Каждый файл в `src/tools/` экспортирует `{ definition, handler }` и автоматически становится
инструментом агента. Эталон — `src/tools/exampleEcho.js`.

```js
// src/tools/getWeather.js
'use strict';

const definition = {
  type: 'function',
  function: {
    name: 'get_weather',
    description: 'Возвращает погоду в городе. Зови, когда пользователь спрашивает погоду.',
    parameters: {
      type: 'object',
      properties: { city: { type: 'string', description: 'Город' } },
      required: ['city'],
    },
  },
};

// context = { channel, chatId, phone, clientName }
async function handler(args, context) {
  // ... вызов API погоды
  return { city: args.city, temp: '+5°C' };
}

module.exports = { definition, handler };
```

Сохранили файл — инструмент уже работает. Проверка:
```bash
node -e "console.log(require('./src/tools').tools.map(t => t.function.name))"
```

> **В Claude Code** для этого есть slash-команда **`/add-tool`** — опишите инструмент словами,
> она сгенерирует файл по канону registry.

---

## Эксплуатация

- **Команды в чате:** `/pause` (`/stop`) — заглушить бота вручную; `/resume` — вернуть.
- **Health-check:** `GET /health` → статус, uptime, память, коннект к MySQL, метрики агента (`status: degraded` при доле ошибок >10%).
- **Graceful shutdown:** корректно по `SIGINT` / `SIGTERM`.
- **Авто-восстановление:** WhatsApp переподключается через 3с после обрыва (если это не logout); туннель рестартует через 10с.

### Ключевые константы (`src/config.js`)

```
BUFFER_WAIT: 1000              окно склейки сообщений (мс)
AI_MAX_ITERATIONS: 20          макс. раундов tool-calling
CHAT_MEMORY_WINDOW: 100        сообщений из MySQL в контекст
CONTEXT_SUMMARY_CHAR_LIMIT: 50000   порог сжатия истории
CONTEXT_KEEP_RECENT_MSGS: 20   дословно хранимых последних сообщений
HANDOFF_TTL: 600               пауза менеджера (сек)
DAILY_IMAGE_LIMIT / DAILY_DOC_LIMIT: 10
```

---

## Тесты

Встроенный тест-раннер Node (`node:test`), без Jest/Vitest.

```bash
node --test                       # все тесты
node --test tests/normalize.test.js   # один файл
```

Покрытие: нормализация каналов, контекст-менеджер, сборка промпта, fallback LLM, санитайзер, `notify_manager`.

---

## FAQ

**Бот не стартует с ошибкой про MySQL.** Это валидация: заполните `MYSQL_*` в `.env`. Без БД ядро намеренно не запускается.

**WhatsApp отвалился после рестарта.** Сессия в `auth_info_baileys/` (в `.gitignore`). Если папка пуста или удалена — привяжите заново через `/pair` или QR.

**Страница `/pair` отдаёт 503.** Не задан `PAIR_TOKEN`. Задайте секрет 16+ символов в `.env`.

**Wazzup не сохраняет вебхук.** Скорее всего блокирует ваш хост (`*.trycloudflare.com`). Используйте свой домен (`WAZZUP_WEBHOOK_BASE_URL`) или прокси-Worker (`cloudflare-worker/`).

**Как сменить модель?** `OPENROUTER_MODEL` в `.env` — любая модель OpenRouter. Для function-calling нужна модель с его поддержкой.

---

## Лицензия

MIT — используйте свободно как основу для своих ботов.

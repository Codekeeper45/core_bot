# Cloudflare Worker — Wazzup proxy

Прокси между Wazzup24 и нашим ботом, чтобы обойти бан `*.trycloudflare.com`
в анти-фрод листах Wazzup. Worker сидит на стабильном `*.workers.dev`
(Cloudflare его не банит), принимает webhook'и от Wazzup в KV-очередь, и
отдаёт их боту через GET `/poll/<secret>`.

## Что развернуть

- `worker.js` — сам Worker (~90 строк, всё в одном файле)
- `wrangler.toml` — конфиг для CLI

## Шаг 1: Cloudflare аккаунт

1. Зарегистрируйся на https://dash.cloudflare.com — бесплатно.
2. После входа в Workers & Pages выбери Workers subdomain (один раз
   на аккаунт), например `myproxy` → у тебя появится домен
   `*.<subdomain>.workers.dev`.

## Шаг 2: Wrangler CLI

```bash
npm install -g wrangler
wrangler login        # откроет браузер, авторизуйся
```

## Шаг 3: Создать KV namespace

```bash
cd cloudflare-worker
wrangler kv namespace create WAZZUP_QUEUE
```

Команда выведет что-то типа:
```
🌀 Creating namespace with title "wazzup-proxy-WAZZUP_QUEUE"
✨ Success!
Add the following to your configuration file in your kv_namespaces array:
[[kv_namespaces]]
binding = "WAZZUP_QUEUE"
id = "abcdef1234567890abcdef1234567890"
```

Скопируй `id` и впиши в `wrangler.toml` вместо `REPLACE_WITH_KV_NAMESPACE_ID`.

## Шаг 4: Положить секрет

```bash
wrangler secret put WEBHOOK_SECRET
```

Wrangler спросит значение — введи ТО ЖЕ, что у бота в `.env` как
`WAZZUP_WEBHOOK_SECRET` (та длинная hex-строка). Это общий ключ:
Worker сверяет URL-путь, бот сверяет URL-путь, секрет в обоих местах
один и тот же.

## Шаг 5: Деплой

```bash
wrangler deploy
```

В выводе будет URL вида:
```
Published wazzup-proxy (1.23 sec)
  https://wazzup-proxy.<subdomain>.workers.dev
```

Это твой стабильный URL. На него Wazzup будет слать webhook'и навсегда.

## Шаг 6: В env бота добавь

```
WAZZUP_WORKER_URL=https://wazzup-proxy.<subdomain>.workers.dev
```

(подставь свой реальный URL из вывода wrangler)

`WAZZUP_WEBHOOK_SECRET` уже должен быть в .env бота — тот же что
скормил wrangler-у на шаге 4.

Рестарт бота. В логах увидишь:
```
[Wazzup] Webhook зарегистрирован (worker): https://wazzup-proxy...
[WazzupPoll] старт: https://wazzup-proxy... раз в 3000 мс
```

## Как проверить что работает

1. Health-check Worker'а:
   ```bash
   curl https://wazzup-proxy.<subdomain>.workers.dev/
   # → {"ok":true,"worker":"wazzup-proxy","ts":...}
   ```

2. Что зарегистрировано в Wazzup сейчас:
   ```bash
   curl https://api.wazzup24.com/v3/webhooks -H "Authorization: Bearer $WAZZUP_API_KEY"
   ```

3. Открой Wazzup в браузере → отправь сообщение в IG-direct аккаунта.
   В логах бота через ~3 секунды:
   ```
   [WazzupPoll] получено 1 payload'ов из Worker'а
   ```

## Лимиты бесплатного плана Cloudflare

| Ресурс | Лимит | Хватит? |
|---|---|---|
| Worker invocations | 100 000/день | да (типично <1000) |
| KV reads | 100 000/день | да (~28800 при поллинге 3с) |
| KV writes | 1 000/день | да до 1000 сообщений/день |
| KV storage | 1 GB | бесконечно |

Если упрёшься в KV writes (>1000 сообщений в сутки) — Paid Workers $5/мес
снимает все лимиты. Но при текущих объёмах не нужно.

## Если надо изменить Worker

Правишь `worker.js`, запускаешь `wrangler deploy`. Изменения применяются
за ~30 секунд глобально. Боту перезапуск не нужен — он использует
Worker через HTTP.

## Удалить полностью

```bash
wrangler delete wazzup-proxy
wrangler kv namespace delete --binding WAZZUP_QUEUE
```

'use strict';
const mysql = require('mysql2/promise');
const config = require('../config');
const { loadEmployeesFromExcel } = require('./employeeImport');
const { pruneCycles } = require('../utils/dag');
const { rollupStatus } = require('../utils/projectRollup');

let pool;

function assertMySqlConfig() {
  const missing = [];
  if (!config.MYSQL_HOST) missing.push('MYSQL_HOST');
  if (!config.MYSQL_DATABASE) missing.push('MYSQL_DATABASE');
  if (!config.MYSQL_USER) missing.push('MYSQL_USER');
  if (!config.MYSQL_PASSWORD) missing.push('MYSQL_PASSWORD');

  if (missing.length > 0) {
    throw new Error(`Missing required MySQL env vars: ${missing.join(', ')}`);
  }
}

function getPool() {
  if (!pool) {
    assertMySqlConfig();
    pool = mysql.createPool({
      host: config.MYSQL_HOST,
      port: config.MYSQL_PORT,
      database: config.MYSQL_DATABASE,
      user: config.MYSQL_USER,
      password: config.MYSQL_PASSWORD,
      waitForConnections: true,
      connectionLimit: 10,
      decimalNumbers: true,
      // Все DATETIME трактуем как UTC независимо от TZ сервера БД — на этом
      // построены планировщики (scheduledRunner/reportScheduler) и daily-counts.
      timezone: 'Z',
    });
    pool.on('error', (err) => console.error('[MySQL] Pool error:', err.message));
  }
  return pool;
}

async function dbQuery(sql, params = []) {
  const [rows] = await getPool().execute(sql, params);
  return rows;
}

// Помечает реальный сбой БД, чтобы вызывающий мог отличить «ошибка инфраструктуры»
// от «запись не найдена» (иначе бот рапортует боссу ложное «не найдено»).
function dbError(err, where) {
  console.error(`[MySQL] ${where}:`, err && err.message);
  const e = new Error('db_error');
  e.dbError = true;
  e.cause = err;
  return e;
}

// Транзакция: fn получает функцию q(sql, params) на том же соединении.
// Любой throw → rollback; иначе commit. Соединение всегда возвращается в пул.
async function withTransaction(fn) {
  const conn = await getPool().getConnection();
  try {
    await conn.beginTransaction();
    const q = async (sql, params = []) => {
      const [rows] = await conn.execute(sql, params);
      return rows;
    };
    const result = await fn(q);
    await conn.commit();
    return result;
  } catch (err) {
    try { await conn.rollback(); } catch (_) { /* rollback best-effort */ }
    throw err;
  } finally {
    conn.release();
  }
}

// ─── Инициализация таблиц ────────────────────────────────────────────────────
async function initTables() {
  // Долгая память чата (история + сжатая сводка)
  await dbQuery(`
    CREATE TABLE IF NOT EXISTS bot_chat_history (
      channel     VARCHAR(20)  NOT NULL,
      chat_id     VARCHAR(255) NOT NULL,
      messages    LONGTEXT     NOT NULL,
      summary     LONGTEXT     NULL,
      version     INT          NOT NULL DEFAULT 0,
      updated_at  TIMESTAMP    DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (channel, chat_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  // Дневные счётчики (лимиты картинок / документов)
  await dbQuery(`
    CREATE TABLE IF NOT EXISTS bot_daily_counts (
      channel     VARCHAR(20)  NOT NULL,
      chat_id     VARCHAR(255) NOT NULL,
      count_type  VARCHAR(20)  NOT NULL,
      count_date  DATE         NOT NULL,
      count       INT          NOT NULL DEFAULT 0,
      PRIMARY KEY (channel, chat_id, count_type, count_date)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  // ─── Оркестратор: сотрудники / проекты / задачи ───────────────────────────
  // Реестр сотрудников. Тестовый сотрудник = channel/contact NULL (диспатч
  // только записывается в БД, реально не отправляется).
  await dbQuery(`
    CREATE TABLE IF NOT EXISTS orch_employees (
      id         INT AUTO_INCREMENT PRIMARY KEY,
      name       VARCHAR(120) NOT NULL,
      roles      VARCHAR(255) NOT NULL,
      skills     TEXT         NULL,
      channel    VARCHAR(20)  NULL,
      contact    VARCHAR(255) NULL,
      active     TINYINT(1)   NOT NULL DEFAULT 1,
      created_at TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uq_emp_contact (channel, contact)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  // Проекты (большие задачи/цели от «босса»).
  await dbQuery(`
    CREATE TABLE IF NOT EXISTS orch_projects (
      id            INT AUTO_INCREMENT PRIMARY KEY,
      title         VARCHAR(255) NOT NULL,
      goal          TEXT         NOT NULL,
      plan          TEXT         NULL,
      status        VARCHAR(20)  NOT NULL DEFAULT 'planning',
      owner_channel VARCHAR(20)  NOT NULL,
      owner_chat_id VARCHAR(255) NOT NULL,
      created_at    TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
      updated_at    TIMESTAMP    DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_proj_owner (owner_channel, owner_chat_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  // Подзадачи. depends_on — список id задач через запятую (рёбра DAG).
  await dbQuery(`
    CREATE TABLE IF NOT EXISTS orch_tasks (
      id          INT AUTO_INCREMENT PRIMARY KEY,
      project_id  INT          NOT NULL,
      title       VARCHAR(255) NOT NULL,
      description TEXT         NULL,
      expected    TEXT         NULL,
      priority    TINYINT      NOT NULL DEFAULT 3,
      depends_on  VARCHAR(255) NULL,
      assignee_id INT          NULL,
      status      VARCHAR(20)  NOT NULL DEFAULT 'todo',
      result      TEXT         NULL,
      dispatched  TINYINT(1)   NOT NULL DEFAULT 0,
      sent        TINYINT(1)   NOT NULL DEFAULT 0,
      created_at  TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
      updated_at  TIMESTAMP    DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_task_project (project_id),
      INDEX idx_task_assignee (assignee_id, status)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  // Настройки рантайма, управляемые ботом (планировщик и т.п.). key-value,
  // чтобы решения ИИ переживали рестарт контейнера.
  await dbQuery(`
    CREATE TABLE IF NOT EXISTS orch_settings (
      k          VARCHAR(64)  PRIMARY KEY,
      v          VARCHAR(255) NOT NULL,
      updated_at TIMESTAMP    DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  // Расписания действий, которые ИИ планирует сам (manage_schedule). В момент
  // срабатывания scheduledRunner выполняет instruction через обычный агентный цикл.
  await dbQuery(`
    CREATE TABLE IF NOT EXISTS orch_schedules (
      id            INT AUTO_INCREMENT PRIMARY KEY,
      owner_channel VARCHAR(20)  NOT NULL,
      owner_chat_id VARCHAR(255) NOT NULL,
      owner_phone   VARCHAR(32)  NULL,
      title         VARCHAR(255) NOT NULL,
      instruction   TEXT         NOT NULL,
      kind          VARCHAR(16)  NOT NULL,
      run_at        DATETIME     NULL,
      at_hour       TINYINT      NULL,
      at_minute     TINYINT      NULL DEFAULT 0,
      weekdays      VARCHAR(20)  NULL,
      month_days    VARCHAR(64)  NULL,
      interval_min  INT          NULL,
      enabled       TINYINT(1)   NOT NULL DEFAULT 1,
      fail_count    INT          NOT NULL DEFAULT 0,
      next_run_at   DATETIME     NULL,
      last_run_at   DATETIME     NULL,
      last_status   VARCHAR(255) NULL,
      created_at    TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
      updated_at    TIMESTAMP    DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_sched_due (enabled, next_run_at),
      INDEX idx_sched_owner (owner_channel, owner_chat_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  // Журнал запусков расписаний (паттерн job_executions): отвечает на «почему вчера
  // не пришло?» фактами. Автоочистка старше 90 дней — в scheduledRunner.
  await dbQuery(`
    CREATE TABLE IF NOT EXISTS orch_schedule_runs (
      id          INT AUTO_INCREMENT PRIMARY KEY,
      schedule_id INT          NOT NULL,
      title       VARCHAR(255) NULL,
      status      VARCHAR(32)  NOT NULL,
      detail      VARCHAR(255) NULL,
      ran_at      TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_runs_sched (schedule_id, ran_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  // Память-факты: что бот запомнил о пользователе (простая, без векторов).
  // Подмешивается в системный промпт для босса.
  await dbQuery(`
    CREATE TABLE IF NOT EXISTS bot_memory_facts (
      id         INT AUTO_INCREMENT PRIMARY KEY,
      channel    VARCHAR(20)  NOT NULL,
      chat_id    VARCHAR(255) NOT NULL,
      fact       TEXT         NOT NULL,
      category   VARCHAR(64)  NULL,
      scope      VARCHAR(10)  NOT NULL DEFAULT 'personal',
      created_at TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_facts_chat (channel, chat_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  // Личные заметки и задачи босса (отдельно от orch_tasks для сотрудников).
  await dbQuery(`
    CREATE TABLE IF NOT EXISTS bot_personal_items (
      id         INT AUTO_INCREMENT PRIMARY KEY,
      channel    VARCHAR(20)  NOT NULL,
      chat_id    VARCHAR(255) NOT NULL,
      kind       VARCHAR(8)   NOT NULL,   -- note | todo
      text       TEXT         NOT NULL,
      done       TINYINT(1)   NOT NULL DEFAULT 0,
      due        DATETIME     NULL,
      created_at TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_items_chat (channel, chat_id, kind, done)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  // Тихий режим («не пиши мне первым»): пока активен — бот НЕ шлёт владельцу
  // проактивных сообщений (расписания/будильники/проверки/сводки). На ответы в
  // диалоге не влияет. quiet_until: NULL = бессрочно; иначе UTC-момент авто-снятия.
  await dbQuery(`
    CREATE TABLE IF NOT EXISTS bot_quiet_state (
      owner_channel VARCHAR(20)  NOT NULL,
      owner_chat_id VARCHAR(255) NOT NULL,
      owner_phone   VARCHAR(32)  NULL,
      quiet_until   DATETIME     NULL,
      updated_at    TIMESTAMP    DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (owner_channel, owner_chat_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  // База знаний по файлам: bot_files — метаданные (владелец = чат, который
  // прислал; visibility: public — ищут все, private — владелец + босс),
  // bot_file_chunks — нарезанный текст с эмбеддингами (embedding NULL, если
  // эмбеддинги были выключены при сохранении — тогда чанк ищется только LIKE'ом).
  await dbQuery(`
    CREATE TABLE IF NOT EXISTS bot_files (
      id          BIGINT AUTO_INCREMENT PRIMARY KEY,
      channel     VARCHAR(20)  NOT NULL,
      chat_id     VARCHAR(255) NOT NULL,
      owner_name  VARCHAR(120) NULL,
      file_name   VARCHAR(255) NOT NULL,
      visibility  VARCHAR(10)  NOT NULL DEFAULT 'public',
      description TEXT         NULL,
      chunk_count INT          NOT NULL DEFAULT 0,
      char_count  INT          NOT NULL DEFAULT 0,
      created_at  TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uq_file_owner_name (channel, chat_id, file_name),
      INDEX idx_files_visibility (visibility)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
  await dbQuery(`
    CREATE TABLE IF NOT EXISTS bot_file_chunks (
      id         BIGINT AUTO_INCREMENT PRIMARY KEY,
      file_id    BIGINT      NOT NULL,
      seq        INT         NOT NULL,
      content    MEDIUMTEXT  NOT NULL,
      embedding  LONGBLOB    NULL,
      dims       INT         NULL,
      model      VARCHAR(64) NULL,
      created_at TIMESTAMP   DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uq_file_seq (file_id, seq),
      INDEX idx_file_chunks_model (model, dims)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  // Приватность чата для ОБЩЕГО поиска памяти (recall/recall_by_date scope=all).
  // Нет строки = 'work' (чат виден всем при поиске по всем чатам). 'private' —
  // чат находят только его владелец и босс. Владелец помечает свой чат сам
  // (инструмент manage_chat_privacy) — личная граница, босс не уведомляется.
  await dbQuery(`
    CREATE TABLE IF NOT EXISTS bot_chat_privacy (
      channel    VARCHAR(20)  NOT NULL,
      chat_id    VARCHAR(255) NOT NULL,
      privacy    VARCHAR(10)  NOT NULL DEFAULT 'work',
      updated_at TIMESTAMP    DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (channel, chat_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  // Остатки склада: одна строка = товар на конкретном складе (location). norm_key —
  // нормализованное наименование (см. utils/stockKey) для поиска/дедупа; UNIQUE
  // (location, norm_key) → upsert по нему. qty DECIMAL: допускает метры/дробное.
  await dbQuery(`
    CREATE TABLE IF NOT EXISTS orch_stock (
      id         INT AUTO_INCREMENT PRIMARY KEY,
      location   VARCHAR(32)   NOT NULL DEFAULT 'Нижний',
      name       VARCHAR(255)  NOT NULL,
      norm_key   VARCHAR(190)  NOT NULL,
      qty        DECIMAL(12,3) NOT NULL DEFAULT 0,
      unit       VARCHAR(16)   NOT NULL DEFAULT 'шт',
      updated_at TIMESTAMP     DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      updated_by VARCHAR(64)   NULL,
      UNIQUE KEY uniq_loc_key (location, norm_key),
      INDEX idx_stock_norm (norm_key)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
  await dbQuery(`
    CREATE TABLE IF NOT EXISTS orch_stock_movements (
      id            BIGINT AUTO_INCREMENT PRIMARY KEY,
      stock_id      INT           NOT NULL,
      movement_type VARCHAR(16)   NOT NULL,
      qty_delta     DECIMAL(12,3) NOT NULL,
      balance_after DECIMAL(12,3) NOT NULL,
      object_ref    VARCHAR(255)  NULL,
      project_id    INT           NULL,
      task_id       INT           NULL,
      actor_name    VARCHAR(120)  NULL,
      note          TEXT          NULL,
      created_at    TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_stock_move_item (stock_id, id),
      INDEX idx_stock_move_date (created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
  await dbQuery(`
    CREATE TABLE IF NOT EXISTS orch_stock_reservations (
      id          BIGINT AUTO_INCREMENT PRIMARY KEY,
      stock_id    INT           NOT NULL,
      qty         DECIMAL(12,3) NOT NULL,
      status      VARCHAR(16)   NOT NULL DEFAULT 'active',
      object_ref  VARCHAR(255)  NULL,
      project_id  INT           NULL,
      task_id     INT           NULL,
      actor_name  VARCHAR(120)  NULL,
      note        TEXT          NULL,
      created_at  TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
      updated_at  TIMESTAMP     DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_stock_res_active (stock_id, status)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
  try {
    await dbQuery('ALTER TABLE orch_stock ADD COLUMN catalog_item_id INT NULL');
  } catch (err) {
    if (err && err.errno !== 1060) console.error('[MySQL] stock catalog link migration:', err.message);
  }
  await dbQuery(
    `INSERT INTO orch_stock_movements (stock_id, movement_type, qty_delta, balance_after, note, created_at)
     SELECT s.id, 'opening', s.qty, s.qty, 'Начальный остаток до журнала движений', s.updated_at
       FROM orch_stock s
      WHERE NOT EXISTS (SELECT 1 FROM orch_stock_movements m WHERE m.stock_id = s.id)`
  );

  // Версионированный каталог розничных цен. Поставщиков несколько (aquastok,
  // gidrolica): у каждого активен свой последний снимок; исходный XLSX в
  // рантайме не читается.
  await dbQuery(`
    CREATE TABLE IF NOT EXISTS orch_price_imports (
      id          INT AUTO_INCREMENT PRIMARY KEY,
      supplier    VARCHAR(32)  NOT NULL DEFAULT 'aquastok',
      source_file VARCHAR(255) NOT NULL,
      source_hash CHAR(64)     NOT NULL,
      sheet_name  VARCHAR(120) NOT NULL,
      price_date  DATE         NULL,
      row_count   INT          NOT NULL DEFAULT 0,
      status      VARCHAR(16)  NOT NULL DEFAULT 'ready',
      created_at  TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uq_price_supplier_hash (supplier, source_hash)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
  await dbQuery(`
    CREATE TABLE IF NOT EXISTS orch_price_items (
      id           INT AUTO_INCREMENT PRIMARY KEY,
      import_id    INT           NOT NULL,
      supplier     VARCHAR(32)   NOT NULL DEFAULT 'aquastok',
      active       TINYINT(1)    NOT NULL DEFAULT 1,
      row_number   INT           NOT NULL,
      series_name  VARCHAR(120)  NULL,
      sku          VARCHAR(64)   NOT NULL,
      source_sku   VARCHAR(64)   NULL,
      sku_norm     VARCHAR(64)   NOT NULL DEFAULT '',
      load_class   VARCHAR(32)   NULL,
      name         TEXT          NOT NULL,
      dn           VARCHAR(32)   NULL,
      length_mm    DECIMAL(12,3) NULL,
      width_mm     DECIMAL(12,3) NULL,
      height_mm    DECIMAL(12,3) NULL,
      weight_kg    DECIMAL(12,3) NULL,
      pallet_qty   VARCHAR(32)   NULL,
      retail_price DECIMAL(14,2) NOT NULL,
      discount_price DECIMAL(14,2) NULL,
      dealer_price   DECIMAL(14,2) NULL,
      dealer_price_2 DECIMAL(14,2) NULL,
      currency     CHAR(3)       NOT NULL DEFAULT 'KZT',
      norm_key     TEXT          NOT NULL,
      created_at   TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uq_price_import_sku (import_id, sku),
      INDEX idx_price_active_sku_norm (active, sku_norm),
      INDEX idx_price_active_sku (active, sku),
      INDEX idx_price_supplier_active (supplier, active)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
  // Неизменяемый журнал ручных правок прайса (кто/когда/старая→новая цена/имя).
  // Аналог orch_stock_movements для склада. Re-import нового файла начинает новый
  // снимок и в журнал не пишет — журнал только про ручные правки боссом/сотрудником.
  await dbQuery(`
    CREATE TABLE IF NOT EXISTS orch_price_changes (
      id            BIGINT AUTO_INCREMENT PRIMARY KEY,
      price_item_id INT           NULL,
      sku           VARCHAR(64)   NOT NULL,
      supplier      VARCHAR(32)   NULL,
      change_type   VARCHAR(16)   NOT NULL,
      old_price     DECIMAL(14,2) NULL,
      new_price     DECIMAL(14,2) NULL,
      old_discount_price DECIMAL(14,2) NULL,
      new_discount_price DECIMAL(14,2) NULL,
      old_name      TEXT          NULL,
      new_name      TEXT          NULL,
      actor_name    VARCHAR(120)  NULL,
      note          TEXT          NULL,
      created_at    TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_price_changes_sku (sku, id),
      INDEX idx_price_changes_date (created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  // Логистика/паллетировка — ОТДЕЛЬНАЯ справочная база (вес, объём, кол-во на
  // паллете), не связана с прайсами. Грузится полным рефрешем из 3 файлов
  // (см. services/logistics.js + scripts/importLogistics.js). Строки тегируются
  // источником (source); дубли артикула из разных файлов сохраняются намеренно,
  // дедуп по приоритету источника — при чтении (logisticsGetByArticle).
  await dbQuery(`
    CREATE TABLE IF NOT EXISTS orch_logistics_items (
      id            BIGINT AUTO_INCREMENT PRIMARY KEY,
      source        VARCHAR(32)   NOT NULL,
      article       VARCHAR(64)   NOT NULL,
      article_norm  VARCHAR(64)   NOT NULL,
      name          TEXT          NOT NULL,
      series        VARCHAR(128)  NULL,
      load_class    VARCHAR(64)   NULL,
      dn            VARCHAR(32)   NULL,
      length_mm     DECIMAL(12,3) NULL,
      width_mm      DECIMAL(12,3) NULL,
      height_mm     DECIMAL(12,3) NULL,
      volume_m3     DECIMAL(12,5) NULL,
      weight_kg     DECIMAL(12,3) NULL,
      qty_per_pallet INT          NULL,
      pallet_weight_kg DECIMAL(12,3) NULL,
      note          TEXT          NULL,
      norm_key      VARCHAR(255)  NOT NULL,
      created_at    TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_logi_article (article_norm),
      INDEX idx_logi_norm (norm_key)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
  // Справочник машин для подбора транспорта под заказ (лист «РАЗМЕЩЕНИЕ ПАЛЕТ»).
  await dbQuery(`
    CREATE TABLE IF NOT EXISTS orch_trucks (
      id             BIGINT AUTO_INCREMENT PRIMARY KEY,
      name           VARCHAR(128) NOT NULL,
      payload_t      DECIMAL(8,2) NULL,
      volume_m3      DECIMAL(8,2) NULL,
      inner_length_m DECIMAL(6,2) NULL,
      inner_width_m  DECIMAL(6,2) NULL,
      inner_height_m DECIMAL(6,2) NULL,
      pallet_places  INT          NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  // Технические события и ручная обратная связь. Запись создаётся до попытки
  // доставки разработчику, поэтому сбой WhatsApp не теряет сообщение.
  await dbQuery(`
    CREATE TABLE IF NOT EXISTS bot_ops_events (
      id              BIGINT AUTO_INCREMENT PRIMARY KEY,
      kind            VARCHAR(32)  NOT NULL,
      severity        VARCHAR(16)  NOT NULL DEFAULT 'info',
      fingerprint     CHAR(64)     NOT NULL,
      source_channel  VARCHAR(20)  NULL,
      source_chat_id  VARCHAR(255) NULL,
      actor_name      VARCHAR(120) NULL,
      message         TEXT         NOT NULL,
      context_text    LONGTEXT     NULL,
      delivery_status VARCHAR(16)  NOT NULL DEFAULT 'pending',
      attempts        INT          NOT NULL DEFAULT 0,
      next_attempt_at DATETIME     NULL,
      delivered_at    DATETIME     NULL,
      created_at      TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_ops_pending (delivery_status, next_attempt_at),
      INDEX idx_ops_fingerprint (fingerprint, created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  // Долгая память: ПОЛНЫЙ архив всей переписки (входящие/исходящие/пересылки).
  // В отличие от bot_chat_history (последнее окно + сводка) — НЕ режется, бот ищет
  // по нему инструментом recall. Это «база знаний», по которой можно поднять любую
  // прошлую переписку («что писали про решётки», «переписка с бухгалтером»).
  await dbQuery(`
    CREATE TABLE IF NOT EXISTS bot_message_archive (
      id          BIGINT AUTO_INCREMENT PRIMARY KEY,
      channel     VARCHAR(20)  NOT NULL,
      chat_id     VARCHAR(255) NOT NULL,
      role        VARCHAR(16)  NOT NULL,
      actor_name  VARCHAR(120) NULL,
      content     MEDIUMTEXT   NOT NULL,
      created_at  TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_archive_chat (channel, chat_id, id),
      INDEX idx_archive_date (created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  // Журнал ВСЕХ действий бота (вызовов инструментов): что сделал, кто инициатор,
  // успех/ошибка, краткая суть. Бот может поднять «когда и что я делал».
  await dbQuery(`
    CREATE TABLE IF NOT EXISTS bot_events (
      id          BIGINT AUTO_INCREMENT PRIMARY KEY,
      channel     VARCHAR(20)  NULL,
      chat_id     VARCHAR(255) NULL,
      actor_name  VARCHAR(120) NULL,
      actor_role  VARCHAR(20)  NULL,
      tool        VARCHAR(64)  NOT NULL,
      action      VARCHAR(64)  NULL,
      success     TINYINT(1)   NOT NULL DEFAULT 1,
      summary     TEXT         NULL,
      created_at  TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_events_chat (channel, chat_id, id),
      INDEX idx_events_tool (tool, id),
      INDEX idx_events_date (created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  // Семантический индекс архива: чанки по N сообщений + их эмбеддинг (BLOB Float32).
  // MariaDB 10.6 без нативного VECTOR — косинус считаем в Node. Один чанк = подряд
  // идущие сообщения одного чата; хранит даты/авторов для точного отчёта по времени.
  await dbQuery(`
    CREATE TABLE IF NOT EXISTS bot_archive_chunks (
      id               BIGINT AUTO_INCREMENT PRIMARY KEY,
      channel          VARCHAR(20)  NOT NULL,
      chat_id          VARCHAR(255) NOT NULL,
      start_archive_id BIGINT       NOT NULL,
      end_archive_id   BIGINT       NOT NULL,
      msg_count        INT          NOT NULL,
      first_at         DATETIME     NULL,
      last_at          DATETIME     NULL,
      authors          VARCHAR(255) NULL,
      content          MEDIUMTEXT   NOT NULL,
      embedding        LONGBLOB     NOT NULL,
      dims             INT          NOT NULL,
      model            VARCHAR(64)  NOT NULL,
      created_at       TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uq_chunk_range (channel, chat_id, start_archive_id),
      INDEX idx_chunk_chat (channel, chat_id, end_archive_id),
      INDEX idx_chunk_model (model, dims)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  await dbQuery(`
    CREATE TABLE IF NOT EXISTS orch_task_events (
      id            BIGINT AUTO_INCREMENT PRIMARY KEY,
      task_id       INT          NOT NULL,
      project_id    INT          NOT NULL,
      event_type    VARCHAR(32)  NOT NULL,
      actor_channel VARCHAR(20)  NULL,
      actor_chat_id VARCHAR(255) NULL,
      actor_name    VARCHAR(120) NULL,
      actor_role    VARCHAR(20)  NULL,
      from_status   VARCHAR(20)  NULL,
      to_status     VARCHAR(20)  NULL,
      payload_json  JSON         NULL,
      created_at    TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_task_events_task (task_id, id),
      INDEX idx_task_events_project (project_id, id),
      INDEX idx_task_events_date (created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
  await dbQuery(`
    CREATE TABLE IF NOT EXISTS orch_task_reports (
      id               BIGINT AUTO_INCREMENT PRIMARY KEY,
      task_id          INT          NOT NULL,
      project_id       INT          NOT NULL,
      reporter_channel VARCHAR(20)  NULL,
      reporter_chat_id VARCHAR(255) NULL,
      reporter_name    VARCHAR(120) NULL,
      status           VARCHAR(20)  NOT NULL,
      comment          TEXT         NOT NULL,
      progress_percent TINYINT      NULL,
      blocker          TEXT         NULL,
      next_step        TEXT         NULL,
      eta              DATETIME     NULL,
      created_at       TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_reports_task (task_id, created_at),
      INDEX idx_reports_date (created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  // Миграция: добавить колонку сводки в уже существующие таблицы истории
  // (CREATE TABLE IF NOT EXISTS не добавит колонку к созданной ранее таблице).
  try {
    await dbQuery('ALTER TABLE bot_chat_history ADD COLUMN summary LONGTEXT NULL');
    console.log('[MySQL] Migrated: bot_chat_history.summary added');
  } catch (err) {
    // ER_DUP_FIELDNAME (1060) = колонка уже есть → ожидаемо, игнорируем.
    if (err && err.errno !== 1060) {
      console.error('[MySQL] summary column migration:', err.message);
    }
  }
  try {
    await dbQuery('ALTER TABLE bot_chat_history ADD COLUMN version INT NOT NULL DEFAULT 0');
  } catch (err) {
    if (err && err.errno !== 1060) console.error('[MySQL] history version migration:', err.message);
  }

  // Миграция: scope у фактов — 'personal' (по чату) | 'global' (правило для всех диалогов).
  try {
    await dbQuery("ALTER TABLE bot_memory_facts ADD COLUMN scope VARCHAR(10) NOT NULL DEFAULT 'personal'");
    console.log('[MySQL] Migrated: bot_memory_facts.scope added');
  } catch (err) {
    if (err && err.errno !== 1060) console.error('[MySQL] facts scope migration:', err.message);
  }

  // Миграция: тайминги задач для метрик (completion time / overdue).
  for (const col of [
    'ADD COLUMN deadline DATETIME NULL',
    'ADD COLUMN dispatched_at DATETIME NULL',
    'ADD COLUMN completed_at DATETIME NULL',
  ]) {
    try {
      await dbQuery(`ALTER TABLE orch_tasks ${col}`);
    } catch (err) {
      if (err && err.errno !== 1060) console.error('[MySQL] orch_tasks migration:', err.message);
    }
  }

  // Миграция прайса Аквасток: скидочная цена, нормализованный артикул и
  // дополнительные поля из файла "Norma с ТТ".
  for (const col of [
    'ADD COLUMN source_sku VARCHAR(64) NULL AFTER sku',
    "ADD COLUMN sku_norm VARCHAR(64) NOT NULL DEFAULT '' AFTER source_sku",
    'ADD COLUMN pallet_qty VARCHAR(32) NULL AFTER weight_kg',
    'ADD COLUMN discount_price DECIMAL(14,2) NULL AFTER retail_price',
  ]) {
    try {
      await dbQuery(`ALTER TABLE orch_price_items ${col}`);
    } catch (err) {
      if (err && err.errno !== 1060) console.error('[MySQL] orch_price_items Aquastok migration:', err.message);
    }
  }
  try {
    await dbQuery('CREATE INDEX idx_price_active_sku_norm ON orch_price_items (active, sku_norm)');
  } catch (err) {
    if (err && err.errno !== 1061 && err.errno !== 1060) console.error('[MySQL] orch_price_items sku_norm index:', err.message);
  }
  for (const col of [
    'ADD COLUMN old_discount_price DECIMAL(14,2) NULL AFTER new_price',
    'ADD COLUMN new_discount_price DECIMAL(14,2) NULL AFTER old_discount_price',
  ]) {
    try {
      await dbQuery(`ALTER TABLE orch_price_changes ${col}`);
    } catch (err) {
      if (err && err.errno !== 1060) console.error('[MySQL] orch_price_changes discount migration:', err.message);
    }
  }

  // Миграция «два поставщика»: supplier-колонки (DEFAULT 'aquastok' бэкфиллит
  // существующий снимок Аквастока — он остаётся активным без переимпорта),
  // уникальность hash становится (supplier, source_hash). Порядок важен:
  // сначала колонка, потом составной уникальный ключ.
  for (const [sql, tolerate] of [
    ["ALTER TABLE orch_price_imports ADD COLUMN supplier VARCHAR(32) NOT NULL DEFAULT 'aquastok' AFTER id", [1060]],
    ['ALTER TABLE orch_price_imports ADD UNIQUE KEY uq_price_supplier_hash (supplier, source_hash)', [1061]],
    ['ALTER TABLE orch_price_imports DROP INDEX uq_price_hash', [1091]],
    ["ALTER TABLE orch_price_items ADD COLUMN supplier VARCHAR(32) NOT NULL DEFAULT 'aquastok' AFTER import_id", [1060]],
    ['CREATE INDEX idx_price_supplier_active ON orch_price_items (supplier, active)', [1061]],
    ['ALTER TABLE orch_price_changes ADD COLUMN supplier VARCHAR(32) NULL AFTER sku', [1060]],
    // Дилерские (закупочные) цены Ballu: Д (<800 тыс/квартал) и Д1 (≥800 тыс).
    ['ALTER TABLE orch_price_items ADD COLUMN dealer_price DECIMAL(14,2) NULL AFTER discount_price', [1060]],
    ['ALTER TABLE orch_price_items ADD COLUMN dealer_price_2 DECIMAL(14,2) NULL AFTER dealer_price', [1060]],
  ]) {
    try {
      await dbQuery(sql);
    } catch (err) {
      if (err && !tolerate.includes(err.errno)) console.error('[MySQL] price supplier migration:', err.message);
    }
  }

  // Старые отмены ранее ошибочно хранились как выполненные. Исправляем их до
  // расчёта KPI и создаём одну стартовую запись журнала для существующих задач.
  await dbQuery(
    `UPDATE orch_tasks SET status = 'cancelled', completed_at = NULL
      WHERE status = 'done' AND result LIKE 'Отменена:%'`
  );
  await dbQuery(
    `INSERT INTO orch_task_events (task_id, project_id, event_type, to_status, payload_json, created_at)
     SELECT t.id, t.project_id, 'snapshot_import', t.status,
            JSON_OBJECT('source', 'pre_journal_state'), t.created_at
       FROM orch_tasks t
      WHERE NOT EXISTS (SELECT 1 FROM orch_task_events e WHERE e.task_id = t.id)`
  );

  // Миграция: предвычисленный момент следующего запуска расписания (модель next_run_at).
  // Backfill старых строк делает scheduledRunner на первом tick (rearmSchedule).
  try {
    await dbQuery('ALTER TABLE orch_schedules ADD COLUMN next_run_at DATETIME NULL AFTER fail_count');
    console.log('[MySQL] Migrated: orch_schedules.next_run_at added');
  } catch (err) {
    if (err && err.errno !== 1060) console.error('[MySQL] orch_schedules migration:', err.message);
  }

  // Миграция: «календарь + будильник + таймер» — фазовый автомат расписаний.
  // fire_phase: pre (пред-напоминание) → main (основное срабатывание) → nag
  // (повтор-будильник до подтверждения босса). next_run_at всегда указывает на
  // ближайшее событие текущей фазы.
  for (const col of [
    "ADD COLUMN fire_phase VARCHAR(8) NOT NULL DEFAULT 'main'",
    'ADD COLUMN nag_interval_min INT NULL',
    'ADD COLUMN nag_max INT NULL',
    'ADD COLUMN nag_count INT NOT NULL DEFAULT 0',
    'ADD COLUMN remind_before_min INT NULL',
    'ADD COLUMN yearly_date CHAR(5) NULL',
    'ADD COLUMN until_at DATETIME NULL',
    'ADD COLUMN max_runs INT NULL',
    'ADD COLUMN run_count INT NOT NULL DEFAULT 0',
    // Сторож исполнения (watchdog): расписание стережёт статус задачи.
    'ADD COLUMN watch_task_id INT NULL',
    'ADD COLUMN watch_goal VARCHAR(12) NULL',
  ]) {
    try {
      await dbQuery(`ALTER TABLE orch_schedules ${col}`);
    } catch (err) {
      if (err && err.errno !== 1060) console.error('[MySQL] orch_schedules phase migration:', err.message);
    }
  }

  // Проверка миграций: если ALTER выше упал не по 1060 (нет колонки) — падаем
  // ГРОМКО на старте, а не делаем вид, что схема готова (иначе ошибки всплывут
  // позже как невнятные сбои запросов).
  await verifyCriticalSchema();

  await seedEmployees();

  console.log('[MySQL] Tables ready');
}

// Пробует выбрать колонки, добавляемые миграциями. Любой сбой (отсутствие
// колонки) → фатальная ошибка инициализации.
async function verifyCriticalSchema() {
  const probes = [
    'SELECT deadline, dispatched_at, completed_at FROM orch_tasks LIMIT 0',
    'SELECT version FROM bot_chat_history LIMIT 0',
    'SELECT supplier, source_hash FROM orch_price_imports LIMIT 0',
    'SELECT supplier, source_sku, sku_norm, pallet_qty, discount_price, dealer_price, dealer_price_2 FROM orch_price_items LIMIT 0',
    'SELECT supplier, change_type, old_discount_price, new_discount_price FROM orch_price_changes LIMIT 0',
    'SELECT role, content FROM bot_message_archive LIMIT 0',
    'SELECT tool, summary FROM bot_events LIMIT 0',
    'SELECT embedding, dims FROM bot_archive_chunks LIMIT 0',
    'SELECT event_type, payload_json FROM orch_task_events LIMIT 0',
    'SELECT delivery_status FROM bot_ops_events LIMIT 0',
    'SELECT movement_type FROM orch_stock_movements LIMIT 0',
    'SELECT status FROM orch_stock_reservations LIMIT 0',
    'SELECT next_run_at, fire_phase, nag_interval_min, until_at, run_count, watch_task_id, watch_goal FROM orch_schedules LIMIT 0',
    'SELECT privacy FROM bot_chat_privacy LIMIT 0',
    'SELECT visibility, chunk_count FROM bot_files LIMIT 0',
    'SELECT embedding, dims FROM bot_file_chunks LIMIT 0',
    'SELECT source, article_norm, qty_per_pallet, volume_m3 FROM orch_logistics_items LIMIT 0',
    'SELECT payload_t, pallet_places FROM orch_trucks LIMIT 0',
  ];
  for (const sql of probes) {
    try {
      await dbQuery(sql);
    } catch (err) {
      throw new Error(`[MySQL] Schema verification failed (миграция не применилась): ${sql} — ${err.message}`);
    }
  }
}

// ─── Оркестратор: сотрудники ─────────────────────────────────────────────────
// Инициализация штата. Источник истины — Excel «Структура Неодрэйн.xlsx»:
// читаем ФИО / должность / обязанности / WhatsApp-телефон и пишем в БД.
// Идемпотентно: если реальные сотрудники (с contact) уже есть — ничего не делаем.
// Если реальных нет — импортируем из Excel (заменяя возможные тестовые заглушки).
// Если файла нет и таблица пуста — оставляем диагностическое пустое состояние,
// не создаём вымышленных сотрудников.

async function seedEmployees() {
  try {
    // Реальные сотрудники (с контактом) уже загружены → выходим.
    const real = await dbQuery('SELECT COUNT(*) AS c FROM orch_employees WHERE contact IS NOT NULL');
    if (real[0] && Number(real[0].c) > 0) return;

    // Импорт реального штата из Excel.
    const fromExcel = loadEmployeesFromExcel();
    if (fromExcel.length) {
      // Убираем тестовые заглушки (без контакта), затем вставляем реальных —
      // атомарно: при сбое посреди процесса откатываемся, чтобы не оставить
      // полу-перестроенный реестр (и не осиротить orch_tasks.assignee_id).
      let inserted = 0;
      await withTransaction(async (q) => {
        await q('DELETE FROM orch_employees WHERE contact IS NULL');
        for (const e of fromExcel) {
          try {
            await q(
              'INSERT INTO orch_employees (name, roles, skills, channel, contact) VALUES (?, ?, ?, ?, ?)',
              [e.name, e.roles || 'сотрудник', e.skills || null, e.channel || null, e.contact || null]
            );
            inserted++;
          } catch (err) {
            // дубль по (channel, contact) — пропускаем строку, не валим транзакцию
            if (!err || err.errno !== 1062) throw err;
          }
        }
      });
      console.log(`[MySQL] Импортировано сотрудников из Excel: ${inserted}`);
      return;
    }

    // Файла нет: существующий реестр не трогаем, пустой оставляем пустым.
    const any = await dbQuery('SELECT COUNT(*) AS c FROM orch_employees');
    if (any[0] && Number(any[0].c) > 0) return;
    console.warn('[MySQL] Реестр сотрудников пуст, Excel штата не найден; тестовые сотрудники не создаются');
  } catch (err) {
    console.error('[MySQL] seedEmployees:', err.message);
  }
}

async function listEmployees() {
  try {
    // Сразу с числом открытых задач, чтобы LLM мог балансировать нагрузку без второго вызова.
    return await dbQuery(`
      SELECT e.id, e.name, e.roles, e.skills, e.channel, e.contact,
             (SELECT COUNT(*) FROM orch_tasks t
                WHERE t.assignee_id = e.id AND t.status NOT IN ('done','cancelled')) AS open_task_count
      FROM orch_employees e
      WHERE e.active = 1
      ORDER BY e.id ASC
    `);
  } catch (err) {
    console.error('[MySQL] listEmployees:', err.message);
    return [];
  }
}

async function findEmployeeByContact(channel, contact) {
  try {
    if (!channel || !contact) return null;
    let c = String(contact);
    // В БД WhatsApp-контакты хранятся голыми цифрами (77071234567), а chat_id из
    // Baileys приходит как JID (77071234567@s.whatsapp.net) — сравниваем по цифрам.
    if (String(channel) === 'whatsapp') {
      c = c.replace(/\D/g, '');
      if (!c) return null;
    }
    const rows = await dbQuery(
      'SELECT * FROM orch_employees WHERE channel = ? AND contact = ? AND active = 1 LIMIT 1',
      [String(channel), c]
    );
    return rows.length ? rows[0] : null;
  } catch (err) {
    console.error('[MySQL] findEmployeeByContact:', err.message);
    return null;
  }
}

async function getEmployeeById(id) {
  try {
    const rows = await dbQuery('SELECT * FROM orch_employees WHERE id = ? LIMIT 1', [id]);
    return rows.length ? rows[0] : null; // null = реально нет такого сотрудника
  } catch (err) {
    throw dbError(err, 'getEmployeeById'); // сбой БД ≠ «не найдено»
  }
}

async function getOpenTasksForEmployee(empId) {
  try {
    return await dbQuery(
      `SELECT id, project_id, title, status, priority FROM orch_tasks
       WHERE assignee_id = ? AND status NOT IN ('done','cancelled') ORDER BY priority ASC, id ASC`,
      [empId]
    );
  } catch (err) {
    console.error('[MySQL] getOpenTasksForEmployee:', err.message);
    return [];
  }
}

// Самая свежая открытая задача сотрудника + проект (для маршрутизации сотрудник→босс).
async function getLatestProjectForEmployee(empId) {
  try {
    const rows = await dbQuery(
      `SELECT p.id, p.title, p.owner_channel, p.owner_chat_id
       FROM orch_tasks t JOIN orch_projects p ON p.id = t.project_id
       WHERE t.assignee_id = ? ORDER BY t.updated_at DESC LIMIT 1`,
      [empId]
    );
    return rows.length ? rows[0] : null;
  } catch (err) {
    console.error('[MySQL] getLatestProjectForEmployee:', err.message);
    return null;
  }
}

// Куда писать боссу, если у сотрудника нет активного проекта: директор/руководитель из реестра
// (с контактом). Возвращает {channel, contact} или null. Fallback на BOSS_CONTACTS/MANAGER_* —
// в самом инструменте.
async function findBossRoute() {
  try {
    const rows = await dbQuery(
      `SELECT channel, contact FROM orch_employees
       WHERE active = 1 AND contact IS NOT NULL
         AND (roles LIKE '%директор%' OR roles LIKE '%руковод%' OR roles LIKE '%босс%')
       ORDER BY id ASC LIMIT 1`
    );
    return rows.length ? { channel: rows[0].channel || 'whatsapp', contact: rows[0].contact } : null;
  } catch (err) {
    console.error('[MySQL] findBossRoute:', err.message);
    return null;
  }
}

// ─── Управление штатом (босс правит список в чате) ───────────────────────────
async function addEmployee({ name, roles, skills, channel, contact }) {
  try {
    const rows = await dbQuery(
      'INSERT INTO orch_employees (name, roles, skills, channel, contact, active) VALUES (?, ?, ?, ?, ?, 1)',
      [name, roles || 'сотрудник', skills || null, channel || null, contact || null]
    );
    return rows.insertId;
  } catch (err) {
    console.error('[MySQL] addEmployee:', err.message);
    return null;
  }
}

async function updateEmployee(id, fields) {
  try {
    const allowed = ['name', 'roles', 'skills', 'channel', 'contact', 'active'];
    const set = [];
    const params = [];
    for (const k of allowed) {
      if (fields[k] !== undefined) { set.push(`${k} = ?`); params.push(fields[k]); }
    }
    if (!set.length) return false;
    params.push(id);
    await dbQuery(`UPDATE orch_employees SET ${set.join(', ')} WHERE id = ?`, params);
    return true;
  } catch (err) {
    console.error('[MySQL] updateEmployee:', err.message);
    return false;
  }
}

// Мягкое удаление: active=0 (чтобы не рвать ссылки orch_tasks.assignee_id).
async function deactivateEmployee(id) {
  try {
    await dbQuery('UPDATE orch_employees SET active = 0 WHERE id = ?', [id]);
    return true;
  } catch (err) {
    console.error('[MySQL] deactivateEmployee:', err.message);
    return false;
  }
}

// Поиск сотрудника по id / имени / роли (для эскалации и правок из чата).
async function findEmployees(query) {
  try {
    const q = String(query || '').trim();
    if (!q) return [];
    if (/^\d+$/.test(q)) {
      return await dbQuery('SELECT * FROM orch_employees WHERE id = ? AND active = 1', [Number(q)]);
    }
    const like = `%${q}%`;
    return await dbQuery(
      'SELECT * FROM orch_employees WHERE active = 1 AND (name LIKE ? OR roles LIKE ? OR skills LIKE ?) ORDER BY id ASC LIMIT 10',
      [like, like, like]
    );
  } catch (err) {
    console.error('[MySQL] findEmployees:', err.message);
    return [];
  }
}

// ─── Оркестратор: проекты ────────────────────────────────────────────────────
async function createProject(title, goal, plan, ownerChannel, ownerChatId) {
  const rows = await dbQuery(
    `INSERT INTO orch_projects (title, goal, plan, owner_channel, owner_chat_id)
     VALUES (?, ?, ?, ?, ?)`,
    [title, goal, plan || null, ownerChannel, ownerChatId]
  );
  return rows.insertId;
}

async function getProject(id) {
  try {
    const rows = await dbQuery('SELECT * FROM orch_projects WHERE id = ? LIMIT 1', [id]);
    return rows.length ? rows[0] : null; // null = реально нет такого проекта
  } catch (err) {
    throw dbError(err, 'getProject'); // сбой БД ≠ «не найдено»
  }
}

async function updateProjectPlan(id, plan) {
  try {
    const res = await dbQuery('UPDATE orch_projects SET plan = ? WHERE id = ?', [plan, id]);
    return (res.affectedRows || 0) > 0;
  } catch (err) {
    throw dbError(err, 'updateProjectPlan');
  }
}

async function setProjectStatus(id, status) {
  try {
    const res = await dbQuery('UPDATE orch_projects SET status = ? WHERE id = ?', [status, id]);
    return (res.affectedRows || 0) > 0;
  } catch (err) {
    throw dbError(err, 'setProjectStatus');
  }
}

// Пересчитывает статус проекта ОДНИМ агрегатом (без read-modify-write на стороне
// Node — это убирает гонку, когда несколько сотрудников отчитываются одновременно).
// done — если все задачи done/cancelled; blocked — если есть заблокированные; иначе active.
// Возвращает выставленный статус (или null при сбое).
async function recomputeProjectStatus(projectId) {
  try {
    const rows = await dbQuery(
      `SELECT COUNT(*) AS total,
              SUM(status = 'done')    AS done,
              SUM(status = 'cancelled') AS cancelled,
              SUM(status = 'blocked') AS blocked
         FROM orch_tasks WHERE project_id = ?`,
      [projectId]
    );
    const r = rows[0] || {};
    const status = rollupStatus({
      total: Number(r.total) || 0,
      done: Number(r.done) || 0,
      cancelled: Number(r.cancelled) || 0,
      blocked: Number(r.blocked) || 0,
    });
    await dbQuery('UPDATE orch_projects SET status = ? WHERE id = ?', [status, projectId]);
    return status;
  } catch (err) {
    throw dbError(err, 'recomputeProjectStatus');
  }
}

// ВСЕ планы системы (для босса-админа): любые владельцы, любые чаты.
async function listAllProjects(limit = 50) {
  try {
    return await dbQuery(
      `SELECT id, title, status, owner_channel, created_at
       FROM orch_projects ORDER BY id DESC LIMIT ?`,
      [Number(limit) || 50]
    );
  } catch (err) {
    console.error('[MySQL] listAllProjects:', err.message);
    return [];
  }
}

// ── Настройки рантайма (orch_settings) ──────────────────────────────────────
async function getSettings(prefix) {
  try {
    const rows = prefix
      ? await dbQuery('SELECT k, v FROM orch_settings WHERE k LIKE ?', [`${prefix}%`])
      : await dbQuery('SELECT k, v FROM orch_settings');
    const out = {};
    for (const r of rows) out[r.k] = r.v;
    return out;
  } catch (err) {
    console.error('[MySQL] getSettings:', err.message);
    return {};
  }
}

async function setSetting(k, v) {
  try {
    await dbQuery(
      'INSERT INTO orch_settings (k, v) VALUES (?, ?) ON DUPLICATE KEY UPDATE v = VALUES(v)',
      [String(k), String(v)]
    );
    return true;
  } catch (err) {
    console.error('[MySQL] setSetting:', err.message);
    return false;
  }
}

// ── Расписания действий (orch_schedules) ────────────────────────────────────
const SCHEDULE_FIELDS = [
  'title', 'instruction', 'kind', 'run_at', 'at_hour', 'at_minute',
  'weekdays', 'month_days', 'interval_min', 'enabled',
  'next_run_at', 'last_run_at', 'fail_count',
  // Календарь + будильник: фазовый автомат и его параметры.
  'fire_phase', 'nag_interval_min', 'nag_max', 'nag_count',
  'remind_before_min', 'yearly_date', 'until_at', 'max_runs', 'run_count',
  // Сторож исполнения (watchdog).
  'watch_task_id', 'watch_goal',
];

async function createSchedule(s) {
  try {
    const rows = await dbQuery(
      `INSERT INTO orch_schedules
        (owner_channel, owner_chat_id, owner_phone, title, instruction, kind,
         run_at, at_hour, at_minute, weekdays, month_days, interval_min, next_run_at,
         fire_phase, nag_interval_min, nag_max, remind_before_min, yearly_date, until_at, max_runs,
         watch_task_id, watch_goal)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        s.owner_channel, String(s.owner_chat_id), s.owner_phone || null,
        s.title, s.instruction, s.kind,
        s.run_at || null, s.at_hour ?? null, s.at_minute ?? 0,
        s.weekdays || null, s.month_days || null, s.interval_min ?? null,
        s.next_run_at || null,
        s.fire_phase || 'main', s.nag_interval_min ?? null, s.nag_max ?? null,
        s.remind_before_min ?? null, s.yearly_date || null, s.until_at || null, s.max_runs ?? null,
        s.watch_task_id ?? null, s.watch_goal || null,
      ]
    );
    return rows.insertId;
  } catch (err) {
    console.error('[MySQL] createSchedule:', err.message);
    throw dbError(err, 'createSchedule');
  }
}

// Все активные расписания (для tick движка).
async function listEnabledSchedules() {
  try {
    return await dbQuery('SELECT * FROM orch_schedules WHERE enabled = 1 ORDER BY id ASC');
  } catch (err) {
    console.error('[MySQL] listEnabledSchedules:', err.message);
    return [];
  }
}

// Расписания конкретного владельца (для list в инструменте).
async function listSchedulesByOwner(channel, chatId, includeDisabled = false) {
  try {
    const where = includeDisabled ? '' : ' AND enabled = 1';
    return await dbQuery(
      `SELECT * FROM orch_schedules WHERE owner_channel = ? AND owner_chat_id = ?${where} ORDER BY id DESC`,
      [String(channel), String(chatId)]
    );
  } catch (err) {
    console.error('[MySQL] listSchedulesByOwner:', err.message);
    return [];
  }
}

async function getSchedule(id) {
  try {
    const rows = await dbQuery('SELECT * FROM orch_schedules WHERE id = ? LIMIT 1', [id]);
    return rows.length ? rows[0] : null;
  } catch (err) {
    throw dbError(err, 'getSchedule');
  }
}

// Точечная правка (whitelist полей). Возвращает число обновлённых полей.
async function updateSchedule(id, fields = {}) {
  const sets = [];
  const vals = [];
  for (const col of SCHEDULE_FIELDS) {
    if (fields[col] !== undefined) { sets.push(`${col} = ?`); vals.push(fields[col]); }
  }
  if (!sets.length) return 0;
  try {
    vals.push(id);
    await dbQuery(`UPDATE orch_schedules SET ${sets.join(', ')} WHERE id = ?`, vals);
    return sets.length;
  } catch (err) {
    console.error('[MySQL] updateSchedule:', err.message);
    return 0;
  }
}

async function setScheduleEnabled(id, on) {
  try {
    await dbQuery('UPDATE orch_schedules SET enabled = ? WHERE id = ?', [on ? 1 : 0, id]);
    return true;
  } catch (err) {
    console.error('[MySQL] setScheduleEnabled:', err.message);
    return false;
  }
}

async function deleteSchedule(id) {
  try {
    const res = await dbQuery('DELETE FROM orch_schedules WHERE id = ?', [id]);
    return (res.affectedRows || 0) > 0;
  } catch (err) {
    console.error('[MySQL] deleteSchedule:', err.message);
    return false;
  }
}

// Успешный (или штатно-завершённый) запуск: фиксируем момент + статус, сбрасываем счётчик
// ошибок и записываем предвычисленный момент следующего запуска (null = больше не планируется).
// opts.bumpRunCount — инкремент счётчика основных (main) срабатываний (для max_runs);
// opts.firePhase — записать новую фазу автомата; opts.nagCount — выставить счётчик повторов.
async function markScheduleRun(id, when, status, nextRunAt = null, opts = {}) {
  try {
    const dt = (when instanceof Date ? when : new Date()).toISOString().slice(0, 19).replace('T', ' ');
    const sets = ['last_run_at = ?', 'last_status = ?', 'fail_count = 0', 'next_run_at = ?'];
    const vals = [dt, String(status || 'ok').slice(0, 250), nextRunAt];
    if (opts.bumpRunCount) sets.push('run_count = run_count + 1');
    if (opts.firePhase !== undefined) { sets.push('fire_phase = ?'); vals.push(opts.firePhase); }
    if (opts.nagCount !== undefined) { sets.push('nag_count = ?'); vals.push(opts.nagCount); }
    vals.push(id);
    await dbQuery(`UPDATE orch_schedules SET ${sets.join(', ')} WHERE id = ?`, vals);
  } catch (err) {
    console.error('[MySQL] markScheduleRun:', err.message);
  }
}

// Атомарный «захват» расписания перед запуском: снимаем next_run_at, только если
// строка всё ещё включена и её время не менялось. Закрывает гонку tick против
// manage_schedule update/cancel (stale-снимок) и дубль при перекрытии двух
// процессов на деплое. true = мы единственный исполнитель; false = расписание
// отменили/перенесли/забрал другой процесс — запускать нельзя.
async function claimSchedule(id, expectedNextRunAt) {
  try {
    const res = await dbQuery(
      `UPDATE orch_schedules SET next_run_at = NULL, last_status = 'running'
       WHERE id = ? AND enabled = 1 AND next_run_at = ?`,
      [id, expectedNextRunAt]
    );
    return (res.affectedRows || 0) === 1;
  } catch (err) {
    console.error('[MySQL] claimSchedule:', err.message);
    return false;
  }
}

// Только перевзвести момент следующего запуска (backfill строк без next_run_at).
async function setScheduleNextRun(id, nextRunAt) {
  try {
    await dbQuery('UPDATE orch_schedules SET next_run_at = ? WHERE id = ?', [nextRunAt, id]);
  } catch (err) {
    console.error('[MySQL] setScheduleNextRun:', err.message);
  }
}

// Записать только статус (lock_busy) — last_run_at НЕ трогаем, чтобы повторить на следующем tick.
async function touchScheduleStatus(id, status) {
  try {
    await dbQuery('UPDATE orch_schedules SET last_status = ? WHERE id = ?', [String(status).slice(0, 250), id]);
  } catch (err) {
    console.error('[MySQL] touchScheduleStatus:', err.message);
  }
}

// Неудача once: +1 к счётчику; после 3 подряд — выключаем (чтобы не досылать вечно битую).
async function bumpScheduleFail(id, status) {
  try {
    await dbQuery(
      `UPDATE orch_schedules
         SET fail_count = fail_count + 1,
             last_status = ?,
             enabled = CASE WHEN fail_count + 1 >= 3 THEN 0 ELSE enabled END
       WHERE id = ?`,
      [String(status || 'error').slice(0, 250), id]
    );
  } catch (err) {
    console.error('[MySQL] bumpScheduleFail:', err.message);
  }
}

async function countSchedules() {
  try {
    const rows = await dbQuery('SELECT COUNT(*) AS enabled FROM orch_schedules WHERE enabled = 1');
    return Number(rows[0] && rows[0].enabled) || 0;
  } catch (err) {
    console.error('[MySQL] countSchedules:', err.message);
    return 0;
  }
}

// ── Успеваемость: агрегация задач по сотрудникам за период ──────────────────
// from/to — границы периода в UTC ('YYYY-MM-DD HH:MM:SS'), to не включается.
// Одним запросом: поставлено за период / из них выполнено / выполнено всего /
// с опозданием / открытых просроченных / заблокированных / среднее время (часы).
async function getEmployeePeriodStats(from, to) {
  try {
    return await dbQuery(
      `SELECT e.id, e.name, e.roles,
              (SELECT COUNT(*) FROM orch_task_events a
                WHERE a.event_type IN ('created','assigned') AND a.created_at >= ? AND a.created_at < ?
                  AND COALESCE(JSON_UNQUOTE(JSON_EXTRACT(a.payload_json, '$.to_assignee_id')),
                               JSON_UNQUOTE(JSON_EXTRACT(a.payload_json, '$.assignee_id'))) = CAST(e.id AS CHAR)) AS assigned,
              (SELECT COUNT(*) FROM orch_task_events a
                WHERE a.event_type IN ('created','assigned') AND a.created_at >= ? AND a.created_at < ?
                  AND COALESCE(JSON_UNQUOTE(JSON_EXTRACT(a.payload_json, '$.to_assignee_id')),
                               JSON_UNQUOTE(JSON_EXTRACT(a.payload_json, '$.assignee_id'))) = CAST(e.id AS CHAR)
                  AND EXISTS (SELECT 1 FROM orch_task_events d WHERE d.task_id = a.task_id
                               AND d.to_status = 'done' AND d.created_at < ?)) AS assigned_done,
              (SELECT COUNT(*) FROM orch_task_events d
                WHERE d.to_status = 'done' AND d.created_at >= ? AND d.created_at < ?
                  AND JSON_UNQUOTE(JSON_EXTRACT(d.payload_json, '$.assignee_id')) = CAST(e.id AS CHAR)) AS done_total,
              (SELECT COUNT(*) FROM orch_task_events d JOIN orch_tasks dt ON dt.id = d.task_id
                WHERE d.to_status = 'done' AND d.created_at >= ? AND d.created_at < ?
                  AND JSON_UNQUOTE(JSON_EXTRACT(d.payload_json, '$.assignee_id')) = CAST(e.id AS CHAR)
                  AND dt.deadline IS NOT NULL AND d.created_at > dt.deadline) AS done_late,
              (SELECT COUNT(*) FROM orch_tasks ot WHERE ot.assignee_id = e.id
                AND ot.status NOT IN ('done','cancelled') AND ot.deadline IS NOT NULL AND ot.deadline < ?) AS open_overdue,
              (SELECT COUNT(*) FROM orch_tasks bt WHERE bt.assignee_id = e.id AND bt.status = 'blocked') AS blocked_now,
              (SELECT AVG(TIMESTAMPDIFF(HOUR, ct.dispatched_at, d.created_at))
                 FROM orch_task_events d JOIN orch_tasks ct ON ct.id = d.task_id
                WHERE d.to_status = 'done' AND d.created_at >= ? AND d.created_at < ?
                  AND JSON_UNQUOTE(JSON_EXTRACT(d.payload_json, '$.assignee_id')) = CAST(e.id AS CHAR)
                  AND ct.dispatched_at IS NOT NULL) AS avg_hours
       FROM orch_employees e
       WHERE e.active = 1
       ORDER BY e.id ASC`,
      [from, to, from, to, to, from, to, from, to, to, from, to]
    );
  } catch (err) {
    console.error('[MySQL] getEmployeePeriodStats:', err.message);
    return [];
  }
}

// ── Журнал запусков расписаний (orch_schedule_runs) ─────────────────────────
async function logScheduleRun(scheduleId, title, status, detail) {
  try {
    await dbQuery(
      'INSERT INTO orch_schedule_runs (schedule_id, title, status, detail) VALUES (?,?,?,?)',
      [scheduleId, title ? String(title).slice(0, 250) : null,
        String(status).slice(0, 30), detail ? String(detail).slice(0, 250) : null]
    );
  } catch (err) {
    console.error('[MySQL] logScheduleRun:', err.message);
  }
}

async function listScheduleRuns(scheduleId, limit = 10) {
  try {
    return await dbQuery(
      `SELECT status, detail, ran_at FROM orch_schedule_runs
       WHERE schedule_id = ? ORDER BY id DESC LIMIT ?`,
      [scheduleId, Number(limit) || 10]
    );
  } catch (err) {
    console.error('[MySQL] listScheduleRuns:', err.message);
    return [];
  }
}

async function cleanupScheduleRuns(days = 90) {
  try {
    const res = await dbQuery(
      'DELETE FROM orch_schedule_runs WHERE ran_at < NOW() - INTERVAL ? DAY',
      [Number(days) || 90]
    );
    return res.affectedRows || 0;
  } catch (err) {
    console.error('[MySQL] cleanupScheduleRuns:', err.message);
    return 0;
  }
}

// ── Память-факты (bot_memory_facts) ─────────────────────────────────────────
function normFact(s) { return String(s || '').trim().toLowerCase().replace(/\s+/g, ' '); }

async function addFact(channel, chatId, fact, category, scope = 'personal') {
  try {
    const sc = scope === 'global' ? 'global' : 'personal';
    // Дедуп: глобальные — среди всех глобальных; личные — в пределах этого чата.
    const existing = sc === 'global'
      ? await dbQuery("SELECT id, fact FROM bot_memory_facts WHERE scope = 'global'")
      : await dbQuery("SELECT id, fact FROM bot_memory_facts WHERE scope = 'personal' AND channel = ? AND chat_id = ?",
        [String(channel), String(chatId)]);
    const norm = normFact(fact);
    const dup = existing.find((r) => normFact(r.fact) === norm);
    if (dup) return { id: dup.id, duplicate: true, scope: sc };
    const res = await dbQuery(
      'INSERT INTO bot_memory_facts (channel, chat_id, fact, category, scope) VALUES (?,?,?,?,?)',
      [String(channel), String(chatId), String(fact), category ? String(category).slice(0, 60) : null, sc]
    );
    return { id: res.insertId, duplicate: false, scope: sc };
  } catch (err) {
    console.error('[MySQL] addFact:', err.message);
    throw dbError(err, 'addFact');
  }
}

// Личные факты ЭТОГО чата + ВСЕ глобальные правила (применяются в любом диалоге).
async function listFacts(channel, chatId, limit = 50) {
  try {
    return await dbQuery(
      `SELECT id, fact, category, scope, created_at FROM bot_memory_facts
       WHERE scope = 'global' OR (channel = ? AND chat_id = ?)
       ORDER BY (scope = 'global') DESC, id DESC LIMIT ?`,
      [String(channel), String(chatId), Number(limit) || 50]
    );
  } catch (err) {
    console.error('[MySQL] listFacts:', err.message);
    return [];
  }
}

// Удалить по id или совпадению текста. Можно удалять СВОИ личные ИЛИ любые глобальные
// (равные права); чужие личные факты не трогаем. Возвращает число удалённых.
async function deleteFact(channel, chatId, { id, match } = {}) {
  try {
    if (id) {
      const res = await dbQuery(
        "DELETE FROM bot_memory_facts WHERE id = ? AND (scope = 'global' OR (channel = ? AND chat_id = ?))",
        [id, String(channel), String(chatId)]);
      return res.affectedRows || 0;
    }
    if (match) {
      const rows = await dbQuery(
        "SELECT id, fact FROM bot_memory_facts WHERE scope = 'global' OR (channel = ? AND chat_id = ?)",
        [String(channel), String(chatId)]);
      const norm = normFact(match);
      const hit = rows.find((r) => normFact(r.fact).includes(norm) || norm.includes(normFact(r.fact)));
      if (!hit) return 0;
      const res = await dbQuery('DELETE FROM bot_memory_facts WHERE id = ?', [hit.id]);
      return res.affectedRows || 0;
    }
    return 0;
  } catch (err) {
    console.error('[MySQL] deleteFact:', err.message);
    return 0;
  }
}

// ── Личные заметки/задачи босса (bot_personal_items) ────────────────────────
async function addPersonalItem(channel, chatId, kind, text, due) {
  try {
    const res = await dbQuery(
      'INSERT INTO bot_personal_items (channel, chat_id, kind, text, due) VALUES (?,?,?,?,?)',
      [String(channel), String(chatId), kind === 'todo' ? 'todo' : 'note', String(text), due || null]
    );
    return res.insertId;
  } catch (err) {
    console.error('[MySQL] addPersonalItem:', err.message);
    throw dbError(err, 'addPersonalItem');
  }
}

async function listPersonalItems(channel, chatId, kind, includeDone = false) {
  try {
    const where = includeDone ? '' : ' AND done = 0';
    return await dbQuery(
      `SELECT id, kind, text, done, due, created_at FROM bot_personal_items
       WHERE channel = ? AND chat_id = ? AND kind = ?${where} ORDER BY (due IS NULL), due ASC, id DESC`,
      [String(channel), String(chatId), kind === 'todo' ? 'todo' : 'note']
    );
  } catch (err) {
    console.error('[MySQL] listPersonalItems:', err.message);
    return [];
  }
}

async function setPersonalItemDone(channel, chatId, id, done = true) {
  try {
    const res = await dbQuery('UPDATE bot_personal_items SET done = ? WHERE id = ? AND channel = ? AND chat_id = ?',
      [done ? 1 : 0, id, String(channel), String(chatId)]);
    return (res.affectedRows || 0) > 0;
  } catch (err) {
    console.error('[MySQL] setPersonalItemDone:', err.message);
    return false;
  }
}

async function deletePersonalItem(channel, chatId, id) {
  try {
    const res = await dbQuery('DELETE FROM bot_personal_items WHERE id = ? AND channel = ? AND chat_id = ?',
      [id, String(channel), String(chatId)]);
    return (res.affectedRows || 0) > 0;
  } catch (err) {
    console.error('[MySQL] deletePersonalItem:', err.message);
    return false;
  }
}

// ВСЕ открытые задачи одним запросом (для сводки нагрузки в list_employees, без N+1).
async function listOpenTasksBrief() {
  try {
    return await dbQuery(
      `SELECT t.id, t.title, t.project_id, t.status, t.assignee_id, t.updated_at, t.deadline,
              (SELECT MAX(r.created_at) FROM orch_task_reports r WHERE r.task_id = t.id) AS last_report_at
       FROM orch_tasks t WHERE t.status NOT IN ('done','cancelled')
       ORDER BY assignee_id, id`
    );
  } catch (err) {
    console.error('[MySQL] listOpenTasksBrief:', err.message);
    return [];
  }
}

async function listProjectsForOwner(channel, chatId) {
  try {
    return await dbQuery(
      `SELECT id, title, status, created_at FROM orch_projects
       WHERE owner_channel = ? AND owner_chat_id = ? ORDER BY id DESC`,
      [channel, chatId]
    );
  } catch (err) {
    console.error('[MySQL] listProjectsForOwner:', err.message);
    return [];
  }
}

// ─── Оркестратор: задачи ─────────────────────────────────────────────────────
// tasksArray: [{ ref, title, description, expected, priority, deadline, depends_on:[ref], assignee_id }]
// Возвращает массив [{ ref, id, title }] (карта временных ref → реальных id), плюс
// свойство .warnings — что было исправлено (невалидный исполнитель, неизвестная
// зависимость, отброшенное цикл-ребро). Вставка и wiring зависимостей атомарны.
async function createTasksBulk(projectId, tasksArray, actor = {}) {
  const warnings = [];

  // Валидация исполнителей: неизвестный/неактивный assignee_id обнуляем.
  const validIds = await getActiveEmployeeIdSet();
  for (const t of tasksArray) {
    if (t.assignee_id != null && !validIds.has(Number(t.assignee_id))) {
      warnings.push(`Исполнитель id=${t.assignee_id} (задача "${t.title || t.ref}") не найден/неактивен — назначение снято.`);
      t.assignee_id = null;
    }
  }

  // Граф зависимостей по ref: ребро ref → ref-зависимость (только из этого батча).
  const refsInBatch = new Set(tasksArray.map((t) => t.ref).filter(Boolean).map(String));
  const refEdges = [];
  for (const t of tasksArray) {
    if (!t.ref) continue;
    const deps = (Array.isArray(t.depends_on) ? t.depends_on : []).map(String);
    const known = [];
    for (const d of deps) {
      if (d === String(t.ref)) continue;       // self-ref
      if (!refsInBatch.has(d)) { warnings.push(`Задача "${t.ref}" зависит от неизвестного ref "${d}" — связь пропущена.`); continue; }
      known.push(d);
    }
    refEdges.push([String(t.ref), known]);
  }
  // Удаляем циклы (оставляем валидный DAG).
  const { adj: cleanAdj, dropped } = pruneCycles(refEdges);
  for (const [from, to] of dropped) warnings.push(`Цикл зависимостей: связь "${from}"→"${to}" отброшена.`);

  // Вставка + wiring — в одной транзакции.
  const out = await withTransaction(async (q) => {
    const refMap = {}; // ref → real id
    const acc = [];
    // 1-й проход: вставляем задачи, строим карту ref → id.
    for (const t of tasksArray) {
      const rows = await q(
        `INSERT INTO orch_tasks (project_id, title, description, expected, priority, deadline, assignee_id)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          projectId,
          String(t.title || '').slice(0, 255),
          t.description || null,
          t.expected || null,
          Number.isInteger(t.priority) ? t.priority : 3,
          t.deadline || null,
          t.assignee_id || null,
        ]
      );
      const id = rows.insertId;
      const [channel, chatId, actorName, actorRole] = actorParts(actor);
      await q(
        `INSERT INTO orch_task_events
         (task_id, project_id, event_type, actor_channel, actor_chat_id, actor_name,
          actor_role, to_status, payload_json)
         VALUES (?, ?, 'created', ?, ?, ?, ?, 'todo', ?)`,
        [id, projectId, channel, chatId, actorName, actorRole,
          JSON.stringify({ title: t.title, assignee_id: t.assignee_id || null, deadline: t.deadline || null })]
      );
      if (t.ref) refMap[String(t.ref)] = id;
      acc.push({ ref: t.ref || null, id, title: t.title });
    }
    // 2-й проход: записываем очищенные (без циклов) зависимости как CSV id.
    for (const item of acc) {
      if (!item.ref) continue;
      const depRefs = cleanAdj.get(String(item.ref)) || [];
      const resolved = depRefs.map((r) => refMap[r]).filter((x) => x != null);
      if (resolved.length) {
        await q('UPDATE orch_tasks SET depends_on = ? WHERE id = ?', [resolved.join(','), item.id]);
      }
    }
    return acc;
  });

  out.warnings = warnings;
  return out;
}

// Множество id активных сотрудников (для валидации назначений).
async function getActiveEmployeeIdSet() {
  try {
    const rows = await dbQuery('SELECT id FROM orch_employees WHERE active = 1');
    return new Set(rows.map((r) => Number(r.id)));
  } catch (err) {
    console.error('[MySQL] getActiveEmployeeIdSet:', err.message);
    return new Set();
  }
}

async function getTask(id) {
  try {
    const rows = await dbQuery('SELECT * FROM orch_tasks WHERE id = ? LIMIT 1', [id]);
    return rows.length ? rows[0] : null; // null = реально нет такой задачи
  } catch (err) {
    throw dbError(err, 'getTask'); // сбой БД ≠ «не найдено»
  }
}

async function listTasksForProject(projectId) {
  try {
    return await dbQuery(
      `SELECT t.id, t.project_id, t.title, t.description, t.expected, t.priority,
              t.depends_on, t.assignee_id, t.status, t.result, t.dispatched, t.sent,
              t.deadline, t.dispatched_at, t.completed_at,
              e.name AS assignee_name
       FROM orch_tasks t
       LEFT JOIN orch_employees e ON e.id = t.assignee_id
       WHERE t.project_id = ?
       ORDER BY t.priority ASC, t.id ASC`,
      [projectId]
    );
  } catch (err) {
    console.error('[MySQL] listTasksForProject:', err.message);
    return [];
  }
}

// Назначение/переназначение. При переназначении уже разосланной/завершённой/
// заблокированной задачи сбрасываем диспатч (новый исполнитель ещё не получал
// бриф) и возвращаем её в очередь (todo), обнуляя тайминги — чтобы метрики и
// статус проекта пересчитались корректно. Возвращает новый статус задачи.
async function assignTask(taskId, employeeId, actor = {}) {
  try {
    return await withTransaction(async (q) => {
      const rows = await q('SELECT id, project_id, assignee_id, status FROM orch_tasks WHERE id = ? LIMIT 1 FOR UPDATE', [taskId]);
      if (!rows.length) return null;
      const task = rows[0];
      await q(
      `UPDATE orch_tasks
         SET assignee_id = ?,
             dispatched = 0,
             sent = 0,
             dispatched_at = CASE WHEN status IN ('dispatched','done','cancelled','blocked') THEN NULL ELSE dispatched_at END,
             completed_at  = CASE WHEN status = 'done' THEN NULL ELSE completed_at END,
             status = CASE WHEN status IN ('dispatched','done','cancelled','blocked') THEN 'todo' ELSE status END
       WHERE id = ?`,
      [employeeId, taskId]
      );
      const current = await q('SELECT status FROM orch_tasks WHERE id = ? LIMIT 1', [taskId]);
      const [channel, chatId, actorName, actorRole] = actorParts(actor);
      await q(
        `INSERT INTO orch_task_events
         (task_id, project_id, event_type, actor_channel, actor_chat_id, actor_name,
          actor_role, from_status, to_status, payload_json)
         VALUES (?, ?, 'assigned', ?, ?, ?, ?, ?, ?, ?)`,
        [task.id, task.project_id, channel, chatId, actorName, actorRole, task.status,
          current[0].status, JSON.stringify({ from_assignee_id: task.assignee_id, to_assignee_id: employeeId })]
      );
      return current[0].status;
    });
  } catch (err) {
    throw dbError(err, 'assignTask');
  }
}

// Точечная правка полей задачи (revise_project edit_tasks). Только whitelist-
// колонки; переназначение исполнителя делает assignTask (со сбросом диспатча).
async function updateTaskFields(taskId, fields = {}, actor = {}) {
  const ALLOWED = ['title', 'description', 'expected', 'priority', 'deadline'];
  const sets = [];
  const vals = [];
  for (const col of ALLOWED) {
    if (fields[col] !== undefined) { sets.push(`${col} = ?`); vals.push(fields[col]); }
  }
  if (!sets.length) return false;
  try {
    return await withTransaction(async (q) => {
      const rows = await q('SELECT id, project_id, assignee_id, status FROM orch_tasks WHERE id = ? LIMIT 1 FOR UPDATE', [taskId]);
      if (!rows.length) return false;
      vals.push(taskId);
      await q(`UPDATE orch_tasks SET ${sets.join(', ')} WHERE id = ?`, vals);
      const [channel, chatId, actorName, actorRole] = actorParts(actor);
      const payload = {};
      for (const col of ALLOWED) if (fields[col] !== undefined) payload[col] = fields[col];
      await q(
        `INSERT INTO orch_task_events
         (task_id, project_id, event_type, actor_channel, actor_chat_id, actor_name,
          actor_role, from_status, to_status, payload_json)
         VALUES (?, ?, 'fields_changed', ?, ?, ?, ?, ?, ?, ?)`,
        [rows[0].id, rows[0].project_id, channel, chatId, actorName, actorRole,
          rows[0].status, rows[0].status, JSON.stringify(payload)]
      );
      return true;
    });
  } catch (err) {
    throw dbError(err, 'updateTaskFields');
  }
}

async function markDispatched(taskId, sent, actor = {}) {
  try {
    return await withTransaction(async (q) => {
      const rows = await q('SELECT id, project_id, status FROM orch_tasks WHERE id = ? LIMIT 1 FOR UPDATE', [taskId]);
      if (!rows.length) return false;
      const task = rows[0];
      await q(
        `UPDATE orch_tasks
           SET dispatched = 1, sent = ?, status = 'dispatched',
               dispatched_at = COALESCE(dispatched_at, NOW())
         WHERE id = ?`,
        [sent ? 1 : 0, taskId]
      );
      const [channel, chatId, actorName, actorRole] = actorParts(actor);
      await q(
        `INSERT INTO orch_task_events
         (task_id, project_id, event_type, actor_channel, actor_chat_id, actor_name,
          actor_role, from_status, to_status, payload_json)
         VALUES (?, ?, 'dispatched', ?, ?, ?, ?, ?, 'dispatched', ?)`,
        [task.id, task.project_id, channel, chatId, actorName, actorRole, task.status,
          JSON.stringify({ sent: Boolean(sent) })]
      );
      return true;
    });
  } catch (err) {
    throw dbError(err, 'markDispatched');
  }
}

async function updateTaskStatus(taskId, status, result, actor = {}) {
  try {
    // completed_at проставляем ТОЛЬКО при переходе в done (write-once через COALESCE).
    // При любом другом статусе completed_at НЕ трогаем — иначе возврат задачи на
    // доработку (done → in_progress → done) затирал бы исторический тайминг и портил
    // метрики времени выполнения. Реальный «reopen» выполняет assignTask.
    const setCompleted = status === 'done' ? ', completed_at = COALESCE(completed_at, NOW())' : '';
    return await withTransaction(async (q) => {
      const rows = await q('SELECT id, project_id, assignee_id, status FROM orch_tasks WHERE id = ? LIMIT 1 FOR UPDATE', [taskId]);
      if (!rows.length) return false;
      const task = rows[0];
      if (result !== undefined && result !== null) {
        await q(
        `UPDATE orch_tasks SET status = ?, result = ?${setCompleted} WHERE id = ?`,
        [status, result, taskId]
        );
      } else {
        await q(
        `UPDATE orch_tasks SET status = ?${setCompleted} WHERE id = ?`,
        [status, taskId]
        );
      }
      const [channel, chatId, actorName, actorRole] = actorParts(actor);
      await q(
        `INSERT INTO orch_task_events
         (task_id, project_id, event_type, actor_channel, actor_chat_id, actor_name,
          actor_role, from_status, to_status, payload_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [task.id, task.project_id, status === 'cancelled' ? 'cancelled' : 'status_changed',
          channel, chatId, actorName, actorRole, task.status, status,
          JSON.stringify({ result: result == null ? null : String(result), assignee_id: task.assignee_id || null })]
      );
      return true;
    });
  } catch (err) {
    throw dbError(err, 'updateTaskStatus');
  }
}

async function setTaskDeadline(taskId, deadline) {
  try {
    const res = await dbQuery('UPDATE orch_tasks SET deadline = ? WHERE id = ?', [deadline, taskId]);
    return (res.affectedRows || 0) > 0;
  } catch (err) {
    throw dbError(err, 'setTaskDeadline');
  }
}

function actorParts(actor = {}) {
  return [
    actor.channel || null,
    actor.chatId || null,
    actor.clientName || actor.name || null,
    actor.role || null,
  ];
}

async function createTaskReport(taskId, report, actor = {}) {
  return withTransaction(async (q) => {
    const rows = await q('SELECT * FROM orch_tasks WHERE id = ? LIMIT 1 FOR UPDATE', [taskId]);
    if (!rows.length) return null;
    const task = rows[0];
    const status = String(report.status || 'in_progress');
    const comment = String(report.comment || '').trim();
    const progress = report.progress_percent == null
      ? null : Math.max(0, Math.min(100, Number(report.progress_percent)));
    const completedSql = status === 'done' ? ', completed_at = COALESCE(completed_at, NOW())' : '';
    await q(
      `UPDATE orch_tasks SET status = ?, result = ?${completedSql} WHERE id = ?`,
      [status, comment, taskId]
    );
    const [channel, chatId, actorName, actorRole] = actorParts(actor);
    const inserted = await q(
      `INSERT INTO orch_task_reports
       (task_id, project_id, reporter_channel, reporter_chat_id, reporter_name,
        status, comment, progress_percent, blocker, next_step, eta)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [task.id, task.project_id, channel, chatId, actorName, status, comment,
        progress, report.blocker || null, report.next_step || null, report.eta || null]
    );
    await q(
      `INSERT INTO orch_task_events
       (task_id, project_id, event_type, actor_channel, actor_chat_id, actor_name,
        actor_role, from_status, to_status, payload_json)
       VALUES (?, ?, 'report', ?, ?, ?, ?, ?, ?, ?)`,
      [task.id, task.project_id, channel, chatId, actorName, actorRole, task.status, status,
        JSON.stringify({ report_id: inserted.insertId, comment, progress_percent: progress,
          assignee_id: task.assignee_id || null,
          blocker: report.blocker || null, next_step: report.next_step || null, eta: report.eta || null })]
    );
    return { ...task, old_status: task.status, status, report_id: inserted.insertId };
  });
}

async function listTaskEvents({ taskId, projectId, limit = 50 } = {}) {
  const where = [];
  const params = [];
  if (taskId != null) { where.push('task_id = ?'); params.push(Number(taskId)); }
  if (projectId != null) { where.push('project_id = ?'); params.push(Number(projectId)); }
  if (!where.length) return [];
  params.push(Math.max(1, Math.min(Number(limit) || 50, 100)));
  return dbQuery(
    `SELECT id, task_id, project_id, event_type, actor_name, actor_role,
            from_status, to_status, payload_json, created_at
       FROM orch_task_events WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT ?`,
    params
  );
}

// ─── Chat history ─────────────────────────────────────────────────────────────
async function loadHistory(channel, chatId) {
  try {
    const rows = await dbQuery(
      'SELECT messages, summary, version FROM bot_chat_history WHERE channel = ? AND chat_id = ?',
      [channel, chatId]
    );
    if (!rows.length) return { summary: '', messages: [], version: 0 };
    return { summary: rows[0].summary || '', messages: JSON.parse(rows[0].messages), version: Number(rows[0].version) || 0 };
  } catch (err) {
    throw dbError(err, 'loadHistory');
  }
}

function _mergeHistory(current, incoming) {
  const a = Array.isArray(current) ? current : [];
  const b = Array.isArray(incoming) ? incoming : [];
  let common = 0;
  while (common < a.length && common < b.length
    && JSON.stringify(a[common]) === JSON.stringify(b[common])) common++;
  return [...a, ...b.slice(common)];
}

async function saveHistory(channel, chatId, messages, summary = '', expectedVersion = null) {
  try {
    // Backstop only — contextManager keeps the array well under this via summarization.
    // Режем по ЧИСТОЙ границе хода: иначе обрезанный массив может начаться с
    // осиротевшего role:'tool' → API 400 на каждом следующем сообщении (чат залипает).
    const { safeTrimHistory } = require('../agent/contextManager');
    const incoming = safeTrimHistory(messages, config.CHAT_MEMORY_WINDOW);
    return await withTransaction(async (q) => {
      const rows = await q(
        'SELECT messages, summary, version FROM bot_chat_history WHERE channel = ? AND chat_id = ? FOR UPDATE',
        [channel, chatId]
      );
      if (!rows.length) {
        await q(
          'INSERT INTO bot_chat_history (channel, chat_id, messages, summary, version) VALUES (?, ?, ?, ?, 1)',
          [channel, chatId, JSON.stringify(incoming), summary || null]
        );
        return 1;
      }
      const currentVersion = Number(rows[0].version) || 0;
      let next = incoming;
      if (expectedVersion != null && Number(expectedVersion) !== currentVersion) {
        let current = [];
        try { current = JSON.parse(rows[0].messages); } catch (_) {}
        next = safeTrimHistory(_mergeHistory(current, incoming), config.CHAT_MEMORY_WINDOW);
      }
      const nextVersion = currentVersion + 1;
      await q(
        `UPDATE bot_chat_history SET messages = ?, summary = ?, version = ?
          WHERE channel = ? AND chat_id = ?`,
        [JSON.stringify(next), summary || rows[0].summary || null, nextVersion, channel, chatId]
      );
      return nextVersion;
    });
  } catch (err) {
    throw dbError(err, 'saveHistory');
  }
}

// Полная очистка истории чата (и сводки) — «начать с чистого листа».
// Возвращает true, если строка существовала и была удалена.
async function clearHistory(channel, chatId) {
  try {
    const res = await dbQuery(
      'DELETE FROM bot_chat_history WHERE channel = ? AND chat_id = ?',
      [channel, chatId]
    );
    return (res.affectedRows || 0) > 0;
  } catch (err) {
    console.error('[MySQL] clearHistory:', err.message);
    return false;
  }
}

// ── Долгая память: архив переписки + журнал действий + recall ────────────────
// Запись в архив — append-only, never throws (память не должна ломать ответ).
async function archiveMessage(channel, chatId, role, content, actorName = null) {
  const text = (content == null ? '' : String(content)).trim();
  if (!channel || !chatId || !text) return;
  try {
    await dbQuery(
      'INSERT INTO bot_message_archive (channel, chat_id, role, actor_name, content) VALUES (?, ?, ?, ?, ?)',
      [String(channel), String(chatId), String(role || 'user').slice(0, 16),
        actorName ? String(actorName).slice(0, 120) : null, text.slice(0, 60000)]
    );
  } catch (err) {
    console.error('[MySQL] archiveMessage:', err.message);
  }
}

async function logBotEvent(data = {}) {
  if (!data.tool) return;
  try {
    await dbQuery(
      `INSERT INTO bot_events (channel, chat_id, actor_name, actor_role, tool, action, success, summary)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [data.channel || null, data.chatId ? String(data.chatId) : null,
        data.actorName ? String(data.actorName).slice(0, 120) : null,
        data.actorRole || null, String(data.tool).slice(0, 64),
        data.action ? String(data.action).slice(0, 64) : null,
        data.success === false ? 0 : 1,
        data.summary ? String(data.summary).slice(0, 2000) : null]
    );
  } catch (err) {
    console.error('[MySQL] logBotEvent:', err.message);
  }
}

// Фильтр приватности для scope='all': не-босс не видит ЧУЖИЕ private-чаты
// (свой чат виден всегда). tableAlias — имя/алиас таблицы с channel/chat_id.
// Возвращает { sql, params } для конкатенации к WHERE (или пустую строку боссу).
function privacyExclusion(tableAlias, viewer) {
  if (!viewer || viewer.isBoss) return { sql: '', params: [] };
  return {
    sql: ` AND NOT EXISTS (SELECT 1 FROM bot_chat_privacy pv
            WHERE pv.channel = ${tableAlias}.channel AND pv.chat_id = ${tableAlias}.chat_id
              AND pv.privacy = 'private'
              AND NOT (${tableAlias}.channel = ? AND ${tableAlias}.chat_id = ?))`,
    params: [String(viewer.channel || ''), String(viewer.chatId || '')],
  };
}

async function setChatPrivacy(channel, chatId, privacy) {
  const value = privacy === 'private' ? 'private' : 'work';
  try {
    await dbQuery(
      `INSERT INTO bot_chat_privacy (channel, chat_id, privacy) VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE privacy = VALUES(privacy)`,
      [channel, String(chatId), value]
    );
    return value;
  } catch (err) { throw dbError(err, 'setChatPrivacy'); }
}

async function getChatPrivacy(channel, chatId) {
  try {
    const rows = await dbQuery(
      'SELECT privacy FROM bot_chat_privacy WHERE channel = ? AND chat_id = ? LIMIT 1',
      [channel, String(chatId)]
    );
    return rows.length ? rows[0].privacy : 'work';
  } catch (err) { throw dbError(err, 'getChatPrivacy'); }
}

// Поиск по архиву переписки (и опционально по действиям/фактам). Токены AND по LIKE.
// scope: 'chat' (только этот чат) | 'all' (по всем чатам). viewer = {channel, chatId,
// isBoss} — при scope=all не-боссу скрываются чужие private-чаты.
async function recallSearch({ channel, chatId, query, scope = 'chat', kind = 'messages', limit = 20, viewer = null } = {}) {
  const { normKey } = require('../utils/stockKey');
  const cap = Math.max(1, Math.min(Number(limit) || 20, 50));
  const tokens = String(query || '').trim() ? normKey(query).split(' ').filter(Boolean).slice(0, 8) : [];
  const out = {};
  const chatFilter = scope === 'all' ? '' : ' AND a.channel = ? AND a.chat_id = ?';
  const chatParams = scope === 'all' ? [] : [channel, chatId];
  const privacy = scope === 'all' ? privacyExclusion('a', viewer) : { sql: '', params: [] };
  try {
    if (kind === 'messages' || kind === 'all') {
      const where = ['1=1'];
      const params = [];
      for (const t of tokens) { where.push('a.content LIKE ?'); params.push(`%${t}%`); }
      const sql = `SELECT a.id, a.channel, a.chat_id, a.role, a.actor_name, a.content, a.created_at
                     FROM bot_message_archive a
                    WHERE ${where.join(' AND ')}${chatFilter}${privacy.sql}
                    ORDER BY a.id DESC LIMIT ?`;
      out.messages = await dbQuery(sql, [...params, ...chatParams, ...privacy.params, cap]);
    }
    if (kind === 'events' || kind === 'all') {
      const where = ['1=1'];
      const params = [];
      for (const t of tokens) { where.push('(a.tool LIKE ? OR a.summary LIKE ?)'); params.push(`%${t}%`, `%${t}%`); }
      const sql = `SELECT a.id, a.channel, a.chat_id, a.actor_name, a.actor_role, a.tool, a.action, a.success, a.summary, a.created_at
                     FROM bot_events a
                    WHERE ${where.join(' AND ')}${chatFilter}${privacy.sql}
                    ORDER BY a.id DESC LIMIT ?`;
      out.events = await dbQuery(sql, [...params, ...chatParams, ...privacy.params, cap]);
    }
    return out;
  } catch (err) {
    throw dbError(err, 'recallSearch');
  }
}

// Точная выборка архива по диапазону дат (UTC-границы). tokens — опц. сужение по
// ключевым словам внутри периода. Хронологический порядок (ASC) — для отчёта.
// viewer — см. recallSearch: при scope=all не-боссу скрываются чужие private-чаты.
async function archiveByDateRange({ channel, chatId, scope = 'chat', fromUtc, toUtc, tokens = [], limit = 100, viewer = null } = {}) {
  const fmt = (d) => (d instanceof Date ? d.toISOString().slice(0, 19).replace('T', ' ') : d);
  const where = ['a.created_at >= ?', 'a.created_at <= ?'];
  const params = [fmt(fromUtc), fmt(toUtc)];
  if (scope !== 'all') { where.push('a.channel = ?', 'a.chat_id = ?'); params.push(channel, chatId); }
  for (const t of (tokens || [])) { where.push('a.content LIKE ?'); params.push(`%${t}%`); }
  const privacy = scope === 'all' ? privacyExclusion('a', viewer) : { sql: '', params: [] };
  params.push(...privacy.params);
  params.push(Math.max(1, Math.min(Number(limit) || 100, 500)));
  try {
    return await dbQuery(
      `SELECT a.id, a.channel, a.chat_id, a.role, a.actor_name, a.content, a.created_at
         FROM bot_message_archive a
        WHERE ${where.join(' AND ')}${privacy.sql}
        ORDER BY a.created_at ASC, a.id ASC LIMIT ?`,
      params
    );
  } catch (err) { throw dbError(err, 'archiveByDateRange'); }
}

// Переписка КОНКРЕТНОГО человека с ботом (инструмент read_person). person =
// {channel, contact, name} из orch_employees. Матч по его чату: chat_id совпадает с
// контактом/цифрами/JID (WA), либо actor_name = имя (фолбэк для WA-LID-раздвоения).
// Возвращаем весь диалог чата (реплики человека + ответы бота) хронологически.
// viewer — та же граница приватности, что и в recall: не-босс не увидит человека,
// если тот пометил свой чат приватным (privacyExclusion). fromUtc/toUtc/tokens — опц.
async function archiveByPerson({ person, fromUtc = null, toUtc = null, tokens = [], limit = 100, viewer = null } = {}) {
  if (!person || !person.channel) return [];
  const fmt = (d) => (d instanceof Date ? d.toISOString().slice(0, 19).replace('T', ' ') : d);
  const contact = String(person.contact || '');
  const digits = contact.replace(/\D/g, '');
  const where = ['a.channel = ?'];
  const params = [String(person.channel)];
  // Идентификация чата человека (устойчиво к каналам и WA-LID).
  const ors = [];
  if (contact) { ors.push('a.chat_id = ?'); params.push(contact); }
  if (digits && digits !== contact) { ors.push('a.chat_id = ?'); params.push(digits); }
  if (digits) { ors.push('a.chat_id LIKE ?'); params.push(`${digits}@%`); }
  if (person.name) { ors.push('a.actor_name = ?'); params.push(String(person.name)); }
  if (!ors.length) return []; // нечем идентифицировать
  where.push(`(${ors.join(' OR ')})`);
  if (fromUtc) { where.push('a.created_at >= ?'); params.push(fmt(fromUtc)); }
  if (toUtc) { where.push('a.created_at <= ?'); params.push(fmt(toUtc)); }
  for (const t of (tokens || [])) { where.push('a.content LIKE ?'); params.push(`%${t}%`); }
  const privacy = privacyExclusion('a', viewer); // всегда: читаем чужой чат
  params.push(...privacy.params);
  params.push(Math.max(1, Math.min(Number(limit) || 100, 500)));
  try {
    return await dbQuery(
      `SELECT a.id, a.channel, a.chat_id, a.role, a.actor_name, a.content, a.created_at
         FROM bot_message_archive a
        WHERE ${where.join(' AND ')}${privacy.sql}
        ORDER BY a.created_at ASC, a.id ASC LIMIT ?`,
      params
    );
  } catch (err) { throw dbError(err, 'archiveByPerson'); }
}

// ── Семантический индекс архива (bot_archive_chunks) ─────────────────────────
// Чаты, где накопилось ≥ chunkSize ещё не заэмбедженных сообщений (есть бэклог).
async function listChatsWithBacklog(chunkSize = 10, limit = 50) {
  try {
    return await dbQuery(
      `SELECT a.channel, a.chat_id,
              COALESCE(MAX(c.end_archive_id), 0) AS watermark,
              SUM(a.id > COALESCE((SELECT MAX(c2.end_archive_id) FROM bot_archive_chunks c2
                                    WHERE c2.channel = a.channel AND c2.chat_id = a.chat_id), 0)) AS backlog
         FROM bot_message_archive a
         LEFT JOIN bot_archive_chunks c ON c.channel = a.channel AND c.chat_id = a.chat_id
        GROUP BY a.channel, a.chat_id
       HAVING backlog >= ?
        ORDER BY backlog DESC
        LIMIT ?`,
      [Number(chunkSize) || 10, Math.max(1, Math.min(Number(limit) || 50, 200))]
    );
  } catch (err) { throw dbError(err, 'listChatsWithBacklog'); }
}

// Сообщения архива чата СТРОГО после afterId (по возрастанию) — для нарезки чанков.
async function archiveMessagesAfter(channel, chatId, afterId, limit = 200) {
  try {
    return await dbQuery(
      `SELECT id, role, actor_name, content, created_at
         FROM bot_message_archive
        WHERE channel = ? AND chat_id = ? AND id > ?
        ORDER BY id ASC LIMIT ?`,
      [channel, chatId, Number(afterId) || 0, Math.max(1, Math.min(Number(limit) || 200, 1000))]
    );
  } catch (err) { throw dbError(err, 'archiveMessagesAfter'); }
}

async function insertArchiveChunk(row) {
  try {
    await dbQuery(
      `INSERT INTO bot_archive_chunks
       (channel, chat_id, start_archive_id, end_archive_id, msg_count, first_at, last_at, authors, content, embedding, dims, model)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE end_archive_id = VALUES(end_archive_id), msg_count = VALUES(msg_count),
         first_at = VALUES(first_at), last_at = VALUES(last_at), authors = VALUES(authors),
         content = VALUES(content), embedding = VALUES(embedding), dims = VALUES(dims), model = VALUES(model)`,
      [row.channel, row.chat_id, row.start_archive_id, row.end_archive_id, row.msg_count,
        row.first_at || null, row.last_at || null, row.authors || null, row.content,
        row.embedding, row.dims, row.model]
    );
  } catch (err) { throw dbError(err, 'insertArchiveChunk'); }
}

// Загрузить чанки-кандидаты для поиска (с эмбеддингами). scope='all' — по всем чатам;
// viewer — см. recallSearch: не-боссу скрываются чужие private-чаты.
async function loadChunkVectors({ channel, chatId, scope = 'chat', model, dims, limit = 5000, viewer = null } = {}) {
  const where = ['a.model = ?', 'a.dims = ?'];
  const params = [model, dims];
  if (scope !== 'all') { where.push('a.channel = ?', 'a.chat_id = ?'); params.push(channel, chatId); }
  const privacy = scope === 'all' ? privacyExclusion('a', viewer) : { sql: '', params: [] };
  params.push(...privacy.params);
  params.push(Math.max(1, Math.min(Number(limit) || 5000, 20000)));
  try {
    return await dbQuery(
      `SELECT a.id, a.channel, a.chat_id, a.start_archive_id, a.end_archive_id, a.msg_count,
              a.first_at, a.last_at, a.authors, a.content, a.embedding
         FROM bot_archive_chunks a
        WHERE ${where.join(' AND ')}${privacy.sql}
        ORDER BY a.end_archive_id DESC LIMIT ?`,
      params
    );
  } catch (err) { throw dbError(err, 'loadChunkVectors'); }
}

// ── База знаний по файлам (bot_files / bot_file_chunks) ─────────────────────
// Видимость: public — ищут/видят все; private — владелец (channel+chat_id) и босс.
// Фильтр для SELECT'ов; f — алиас bot_files. Боссу фильтр не нужен.
function fileVisibilityFilter(viewer) {
  if (!viewer || viewer.isBoss) return { sql: '', params: [] };
  return {
    sql: " AND (f.visibility = 'public' OR (f.channel = ? AND f.chat_id = ?))",
    params: [String(viewer.channel || ''), String(viewer.chatId || '')],
  };
}

// Сохранить файл целиком (метаданные + чанки) в одной транзакции. Тот же
// владелец + то же имя = полная замена (старые чанки удаляются).
async function replaceFile({ channel, chatId, ownerName, fileName, visibility = 'public', description = null, charCount = 0, chunks = [] } = {}) {
  try {
    return await withTransaction(async (q) => {
      const existing = await q(
        'SELECT id FROM bot_files WHERE channel = ? AND chat_id = ? AND file_name = ? LIMIT 1',
        [channel, String(chatId), fileName]
      );
      let fileId;
      let replaced = false;
      if (existing.length) {
        fileId = existing[0].id;
        replaced = true;
        await q('DELETE FROM bot_file_chunks WHERE file_id = ?', [fileId]);
        await q(
          'UPDATE bot_files SET owner_name = ?, visibility = ?, description = ?, chunk_count = ?, char_count = ? WHERE id = ?',
          [ownerName || null, visibility, description, chunks.length, charCount, fileId]
        );
      } else {
        const res = await q(
          `INSERT INTO bot_files (channel, chat_id, owner_name, file_name, visibility, description, chunk_count, char_count)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [channel, String(chatId), ownerName || null, fileName, visibility, description, chunks.length, charCount]
        );
        fileId = res.insertId;
      }
      for (const c of chunks) {
        await q(
          'INSERT INTO bot_file_chunks (file_id, seq, content, embedding, dims, model) VALUES (?, ?, ?, ?, ?, ?)',
          [fileId, c.seq, c.content, c.embedding || null, c.dims || null, c.model || null]
        );
      }
      return { id: fileId, replaced };
    });
  } catch (err) { throw dbError(err, 'replaceFile'); }
}

async function listFiles({ viewer } = {}) {
  const vis = fileVisibilityFilter(viewer);
  try {
    return await dbQuery(
      `SELECT f.id, f.channel, f.chat_id, f.owner_name, f.file_name, f.visibility,
              f.description, f.chunk_count, f.char_count, f.created_at
         FROM bot_files f
        WHERE 1=1${vis.sql}
        ORDER BY f.created_at DESC, f.id DESC LIMIT 100`,
      vis.params
    );
  } catch (err) { throw dbError(err, 'listFiles'); }
}

// Найти файл по id или имени. По имени предпочитаем СВОЙ файл (у разных
// владельцев могут быть одноимённые), затем любой видимый.
async function findFile({ id = null, fileName = null, viewer } = {}) {
  const vis = fileVisibilityFilter(viewer);
  try {
    if (id != null) {
      const rows = await dbQuery(
        `SELECT f.* FROM bot_files f WHERE f.id = ?${vis.sql} LIMIT 1`,
        [Number(id), ...vis.params]
      );
      return rows[0] || null;
    }
    if (fileName) {
      const rows = await dbQuery(
        `SELECT f.* FROM bot_files f
          WHERE f.file_name = ?${vis.sql}
          ORDER BY (f.channel = ? AND f.chat_id = ?) DESC, f.id DESC LIMIT 1`,
        [String(fileName), ...vis.params, String((viewer && viewer.channel) || ''), String((viewer && viewer.chatId) || '')]
      );
      return rows[0] || null;
    }
    return null;
  } catch (err) { throw dbError(err, 'findFile'); }
}

async function deleteFile(id) {
  try {
    return await withTransaction(async (q) => {
      await q('DELETE FROM bot_file_chunks WHERE file_id = ?', [Number(id)]);
      const res = await q('DELETE FROM bot_files WHERE id = ?', [Number(id)]);
      return (res.affectedRows || 0) > 0;
    });
  } catch (err) { throw dbError(err, 'deleteFile'); }
}

// Массовая очистка — ТОЛЬКО свои файлы (owner-scope, без scope=all).
async function clearFiles({ channel, chatId } = {}) {
  try {
    return await withTransaction(async (q) => {
      const own = await q('SELECT id FROM bot_files WHERE channel = ? AND chat_id = ?', [channel, String(chatId)]);
      if (!own.length) return { deleted: 0 };
      const ids = own.map((r) => r.id);
      const placeholders = ids.map(() => '?').join(',');
      await q(`DELETE FROM bot_file_chunks WHERE file_id IN (${placeholders})`, ids);
      const res = await q(`DELETE FROM bot_files WHERE id IN (${placeholders})`, ids);
      return { deleted: res.affectedRows || ids.length };
    });
  } catch (err) { throw dbError(err, 'clearFiles'); }
}

async function setFileVisibility(id, visibility) {
  const value = visibility === 'private' ? 'private' : 'public';
  try {
    const res = await dbQuery('UPDATE bot_files SET visibility = ? WHERE id = ?', [value, Number(id)]);
    return (res.affectedRows || 0) > 0 ? value : null;
  } catch (err) { throw dbError(err, 'setFileVisibility'); }
}

async function renameFile(id, newName) {
  try {
    const res = await dbQuery('UPDATE bot_files SET file_name = ? WHERE id = ?', [String(newName), Number(id)]);
    return (res.affectedRows || 0) > 0;
  } catch (err) { throw dbError(err, 'renameFile'); }
}

// Чанки-кандидаты для семантического поиска (только с эмбеддингами нужной модели).
async function loadFileChunkVectors({ viewer, model, dims, fileName = null, limit = 5000 } = {}) {
  const vis = fileVisibilityFilter(viewer);
  const where = ['c.embedding IS NOT NULL', 'c.model = ?', 'c.dims = ?'];
  const params = [model, dims];
  let extra = vis.sql;
  params.push(...vis.params);
  if (fileName) { extra += ' AND f.file_name = ?'; params.push(String(fileName)); }
  params.push(Math.max(1, Math.min(Number(limit) || 5000, 20000)));
  try {
    return await dbQuery(
      `SELECT c.id, c.file_id, c.seq, c.content, c.embedding,
              f.file_name, f.owner_name, f.visibility
         FROM bot_file_chunks c JOIN bot_files f ON f.id = c.file_id
        WHERE ${where.join(' AND ')}${extra}
        ORDER BY c.id DESC LIMIT ?`,
      params
    );
  } catch (err) { throw dbError(err, 'loadFileChunkVectors'); }
}

// Дословный поиск по содержимому чанков (fallback + чанки без эмбеддингов).
async function fileKeywordSearch({ viewer, query, fileName = null, limit = 6 } = {}) {
  const { normKey } = require('../utils/stockKey');
  const vis = fileVisibilityFilter(viewer);
  const tokens = String(query || '').trim() ? normKey(query).split(' ').filter(Boolean).slice(0, 8) : [];
  const where = ['1=1'];
  const params = [];
  for (const t of tokens) { where.push('c.content LIKE ?'); params.push(`%${t}%`); }
  let extra = vis.sql;
  params.push(...vis.params);
  if (fileName) { extra += ' AND f.file_name = ?'; params.push(String(fileName)); }
  params.push(Math.max(1, Math.min(Number(limit) || 6, 15)));
  try {
    return await dbQuery(
      `SELECT c.id, c.file_id, c.seq, c.content,
              f.file_name, f.owner_name, f.visibility
         FROM bot_file_chunks c JOIN bot_files f ON f.id = c.file_id
        WHERE ${where.join(' AND ')}${extra}
        ORDER BY c.file_id DESC, c.seq ASC LIMIT ?`,
      params
    );
  } catch (err) { throw dbError(err, 'fileKeywordSearch'); }
}

// ─── Daily counts (images / documents) ───────────────────────────────────────
async function checkDailyCount(channel, chatId, type, limit) {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const rows = await dbQuery(
      'SELECT count FROM bot_daily_counts WHERE channel = ? AND chat_id = ? AND count_type = ? AND count_date = ?',
      [channel, chatId, type, today]
    );
    return rows.length > 0 && rows[0].count >= limit;
  } catch (err) {
    console.error('[MySQL] checkDailyCount:', err.message);
    return false;
  }
}

async function incrementDailyCount(channel, chatId, type) {
  try {
    const today = new Date().toISOString().slice(0, 10);
    await dbQuery(
      `INSERT INTO bot_daily_counts (channel, chat_id, count_type, count_date, count)
       VALUES (?, ?, ?, ?, 1)
       ON DUPLICATE KEY UPDATE count = count + 1`,
      [channel, chatId, type, today]
    );
  } catch (err) {
    console.error('[MySQL] incrementDailyCount:', err.message);
  }
}

// ── Тихий режим («не пиши мне первым») ──────────────────────────────────────
// untilUtc: UTC-строка 'YYYY-MM-DD HH:MM:SS' для авто-снятия или null = бессрочно.
async function setQuiet(channel, chatId, phone, untilUtc) {
  try {
    await dbQuery(
      `INSERT INTO bot_quiet_state (owner_channel, owner_chat_id, owner_phone, quiet_until)
       VALUES (?,?,?,?)
       ON DUPLICATE KEY UPDATE owner_phone = VALUES(owner_phone), quiet_until = VALUES(quiet_until)`,
      [String(channel), String(chatId), phone || null, untilUtc || null]
    );
    return true;
  } catch (err) {
    console.error('[MySQL] setQuiet:', err.message);
    throw dbError(err, 'setQuiet');
  }
}

async function clearQuiet(channel, chatId) {
  try {
    const res = await dbQuery(
      'DELETE FROM bot_quiet_state WHERE owner_channel = ? AND owner_chat_id = ?',
      [String(channel), String(chatId)]
    );
    return res.affectedRows > 0;
  } catch (err) {
    console.error('[MySQL] clearQuiet:', err.message);
    throw dbError(err, 'clearQuiet');
  }
}

// Текущая запись тишины владельца (или null). active=true, если режим ещё действует.
async function getQuiet(channel, chatId) {
  try {
    const rows = await dbQuery(
      `SELECT owner_channel, owner_chat_id, owner_phone, quiet_until,
              (quiet_until IS NULL OR quiet_until > UTC_TIMESTAMP()) AS active
       FROM bot_quiet_state WHERE owner_channel = ? AND owner_chat_id = ? LIMIT 1`,
      [String(channel), String(chatId)]
    );
    return rows.length ? rows[0] : null;
  } catch (err) {
    console.error('[MySQL] getQuiet:', err.message);
    return null;
  }
}

// Владельцы, у кого тихий режим ДЕЙСТВУЕТ прямо сейчас (для планировщиков).
async function listActiveQuiet() {
  try {
    return await dbQuery(
      `SELECT owner_channel, owner_chat_id, owner_phone FROM bot_quiet_state
       WHERE quiet_until IS NULL OR quiet_until > UTC_TIMESTAMP()`
    );
  } catch (err) {
    console.error('[MySQL] listActiveQuiet:', err.message);
    return [];
  }
}


// ── Технические события / обратная связь ────────────────────────────────────
async function createOpsEvent(data) {
  if (data.deduplicate) {
    const recent = await dbQuery(
      `SELECT id FROM bot_ops_events
        WHERE fingerprint = ? AND created_at >= NOW() - INTERVAL 15 MINUTE
        ORDER BY id DESC LIMIT 1`,
      [data.fingerprint]
    );
    if (recent.length) return { id: recent[0].id, deduplicated: true };
  }
  const res = await dbQuery(
    `INSERT INTO bot_ops_events
     (kind, severity, fingerprint, source_channel, source_chat_id, actor_name, message, context_text)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [data.kind, data.severity, data.fingerprint, data.sourceChannel, data.sourceChatId,
      data.actorName, data.message, data.context || null]
  );
  return {
    id: res.insertId,
    kind: data.kind,
    severity: data.severity,
    source_channel: data.sourceChannel,
    source_chat_id: data.sourceChatId,
    actor_name: data.actorName,
    message: data.message,
    context_text: data.context || '',
  };
}

async function listPendingOpsEvents(limit = 20) {
  return dbQuery(
    `SELECT * FROM bot_ops_events
      WHERE delivery_status = 'pending' AND attempts < 10
        AND (next_attempt_at IS NULL OR next_attempt_at <= NOW())
      ORDER BY id ASC LIMIT ?`,
    [Math.max(1, Math.min(Number(limit) || 20, 100))]
  );
}

async function markOpsEventDelivered(id) {
  const res = await dbQuery(
    `UPDATE bot_ops_events SET delivery_status = 'delivered', delivered_at = NOW() WHERE id = ?`,
    [id]
  );
  return (res.affectedRows || 0) > 0;
}

async function markOpsEventAttempt(id) {
  const res = await dbQuery(
    `UPDATE bot_ops_events
        SET attempts = attempts + 1, next_attempt_at = DATE_ADD(NOW(), INTERVAL 5 MINUTE)
      WHERE id = ?`,
    [id]
  );
  return (res.affectedRows || 0) > 0;
}

// ── Прайс-каталог ───────────────────────────────────────────────────────────
function normalizeSku(sku) {
  return String(sku || '')
    .trim()
    .toUpperCase()
    .replace(/\s+/g, '')
    .replace(/А/g, 'A')
    .replace(/В/g, 'B')
    .replace(/Е/g, 'E')
    .replace(/К/g, 'K')
    .replace(/М/g, 'M')
    .replace(/Н/g, 'H')
    .replace(/О/g, 'O')
    .replace(/Р/g, 'P')
    .replace(/С/g, 'C')
    .replace(/Т/g, 'T')
    .replace(/Х/g, 'X');
}

async function importPriceCatalog(parsed, opts = {}) {
  const supplier = String(parsed.supplier || '').trim();
  if (!supplier) throw new Error('price_import_missing_supplier');
  return withTransaction(async (q) => {
    const existing = await q(
      'SELECT id, row_count FROM orch_price_imports WHERE supplier = ? AND source_hash = ? AND status = ? LIMIT 1',
      [supplier, parsed.source_hash, 'ready']
    );
    if (existing.length && !opts.force) {
      await q('UPDATE orch_price_items SET active = 0 WHERE active = 1 AND supplier = ?', [supplier]);
      await q('UPDATE orch_price_items SET active = 1 WHERE import_id = ?', [existing[0].id]);
      return { imported: false, supplier, import_id: existing[0].id, row_count: existing[0].row_count, activated: true };
    }
    if (existing.length && opts.force) {
      // Тот же файл, но новый парсер: сносим старый снимок и вставляем заново.
      await q('DELETE FROM orch_price_items WHERE import_id = ?', [existing[0].id]);
      await q('DELETE FROM orch_price_imports WHERE id = ?', [existing[0].id]);
    }

    const head = await q(
      `INSERT INTO orch_price_imports
       (supplier, source_file, source_hash, sheet_name, price_date, row_count, status)
       VALUES (?, ?, ?, ?, ?, ?, 'ready')`,
      [supplier, parsed.source_file, parsed.source_hash, parsed.sheet, parsed.price_date || null, parsed.items.length]
    );
    const importId = head.insertId;
    // Импорт затрагивает только снимок СВОЕГО поставщика: второй каталог не трогаем.
    await q('UPDATE orch_price_items SET active = 0 WHERE active = 1 AND supplier = ?', [supplier]);
    for (const item of parsed.items) {
      await q(
        `INSERT INTO orch_price_items
         (import_id, supplier, active, row_number, series_name, sku, source_sku, sku_norm, load_class, name, dn,
          length_mm, width_mm, height_mm, weight_kg, pallet_qty, retail_price, discount_price,
          dealer_price, dealer_price_2, currency, norm_key)
         VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [importId, supplier, item.row_number, item.series, item.sku, item.source_sku || null, normalizeSku(item.sku),
          item.load_class, item.name, item.dn, item.length_mm, item.width_mm, item.height_mm, item.weight_kg,
          item.pallet_qty || null, item.retail_price, item.discount_price,
          item.dealer_price ?? null, item.dealer_price_2 ?? null, item.currency || 'KZT', item.norm_key]
      );
    }
    return { imported: true, supplier, import_id: importId, row_count: parsed.items.length };
  });
}

// Один артикул может существовать у обоих поставщиков (например «1101») —
// возвращаем МАССИВ совпадений; вызывающий решает, что делать с неоднозначностью.
async function priceGetBySku(sku, supplier = null) {
  const normalized = normalizeSku(sku);
  const params = [normalized, String(sku || '').trim()];
  let where = 'p.active = 1 AND (p.sku_norm = ? OR UPPER(p.sku) = UPPER(?))';
  if (supplier) { where += ' AND p.supplier = ?'; params.push(supplier); }
  try {
    return await dbQuery(
      `SELECT p.*, i.source_file, i.price_date
         FROM orch_price_items p JOIN orch_price_imports i ON i.id = p.import_id
        WHERE ${where} ORDER BY p.supplier ASC LIMIT 5`,
      params
    );
  } catch (err) { throw dbError(err, 'priceGetBySku'); }
}

async function priceSearch(query, limit = 20, supplier = null) {
  const { normKey } = require('../utils/stockKey');
  const skuNorm = normalizeSku(query);
  const qNorm = normKey(query);
  const tokens = qNorm.split(' ').filter(Boolean).slice(0, 8);
  const where = ['p.active = 1'];
  const params = [];
  if (supplier) { where.push('p.supplier = ?'); params.push(supplier); }
  if (tokens.length) {
    const tokenWhere = [];
    for (const token of tokens) { tokenWhere.push('p.norm_key LIKE ?'); params.push(`%${token}%`); }
    where.push(`(p.sku_norm = ? OR (${tokenWhere.join(' AND ')}))`);
    params.splice(params.length - tokenWhere.length, 0, skuNorm);
  }
  params.push(Math.max(1, Math.min(Number(limit) || 20, 50)));
  try {
    return await dbQuery(
      `SELECT p.*, i.source_file, i.price_date
         FROM orch_price_items p JOIN orch_price_imports i ON i.id = p.import_id
        WHERE ${where.join(' AND ')}
        ORDER BY p.supplier ASC, p.sku ASC LIMIT ?`,
      params
    );
  } catch (err) { throw dbError(err, 'priceSearch'); }
}

// ── Логистика/паллетировка: отдельная справочная база ───────────────────────
// Полный рефреш: импорт чистит обе таблицы и перезаливает из файлов. Дедуп по
// приоритету источника (palletirovka — самый полный) делается при чтении.

const LOGI_SOURCE_PRIORITY = ['palletirovka', 'raspal_tde', 'raspal_beton', 'raspal_yartsevo', 'ves_plastik'];

// Разбивает массив на чанки для bulk-INSERT (conn.execute не поддерживает `VALUES ?`).
function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function importLogistics(items, trucks) {
  const { normKey } = require('../utils/stockKey');
  return withTransaction(async (q) => {
    await q('DELETE FROM orch_logistics_items');
    await q('DELETE FROM orch_trucks');

    const itemCols = 16; // число плейсхолдеров на строку ниже
    for (const batch of chunk(items, 200)) {
      const placeholders = batch.map(() => `(${Array(itemCols).fill('?').join(',')})`).join(',');
      const params = [];
      for (const it of batch) {
        const normedKey = it.norm_key
          || normKey([it.article, it.name, it.series, it.dn, it.load_class].filter(Boolean).join(' '));
        params.push(
          it.source, it.article, normalizeSku(it.article), it.name,
          it.series ?? null, it.load_class ?? null, it.dn ?? null,
          it.length_mm ?? null, it.width_mm ?? null, it.height_mm ?? null,
          it.volume_m3 ?? null, it.weight_kg ?? null, it.qty_per_pallet ?? null,
          it.pallet_weight_kg ?? null, it.note ?? null, normedKey
        );
      }
      await q(
        `INSERT INTO orch_logistics_items
         (source, article, article_norm, name, series, load_class, dn,
          length_mm, width_mm, height_mm, volume_m3, weight_kg, qty_per_pallet,
          pallet_weight_kg, note, norm_key)
         VALUES ${placeholders}`,
        params
      );
    }

    const truckCols = 7;
    for (const batch of chunk(trucks, 200)) {
      const placeholders = batch.map(() => `(${Array(truckCols).fill('?').join(',')})`).join(',');
      const params = [];
      for (const t of batch) {
        params.push(
          t.name, t.payload_t ?? null, t.volume_m3 ?? null,
          t.inner_length_m ?? null, t.inner_width_m ?? null, t.inner_height_m ?? null,
          t.pallet_places ?? null
        );
      }
      await q(
        `INSERT INTO orch_trucks
         (name, payload_t, volume_m3, inner_length_m, inner_width_m, inner_height_m, pallet_places)
         VALUES ${placeholders}`,
        params
      );
    }

    return { items_count: items.length, trucks_count: trucks.length };
  });
}

// Все строки одного артикула, самый полный источник — первым.
async function logisticsGetByArticle(article) {
  const normalized = normalizeSku(article);
  try {
    return await dbQuery(
      `SELECT * FROM orch_logistics_items
        WHERE article_norm = ? OR UPPER(article) = UPPER(?)
        ORDER BY FIELD(source, ${LOGI_SOURCE_PRIORITY.map(() => '?').join(',')})`,
      [normalized, String(article || '').trim(), ...LOGI_SOURCE_PRIORITY]
    );
  } catch (err) { throw dbError(err, 'logisticsGetByArticle'); }
}

// Поиск по названию/DN/классу: AND по токенам запроса (как priceSearch).
async function logisticsSearch(query, limit = 6) {
  const { normKey } = require('../utils/stockKey');
  const artNorm = normalizeSku(query);
  const tokens = normKey(query).split(' ').filter(Boolean).slice(0, 8);
  const where = [];
  const params = [];
  if (tokens.length) {
    const tokenWhere = [];
    for (const token of tokens) { tokenWhere.push('norm_key LIKE ?'); params.push(`%${token}%`); }
    where.push(`(article_norm = ? OR (${tokenWhere.join(' AND ')}))`);
    params.splice(params.length - tokenWhere.length, 0, artNorm);
  } else {
    where.push('article_norm = ?');
    params.push(artNorm);
  }
  // Приоритет источника: подставляем список в FIELD() перед LIMIT.
  const priorityParams = [...LOGI_SOURCE_PRIORITY];
  const sql =
    `SELECT * FROM orch_logistics_items
      WHERE ${where.join(' AND ')}
      ORDER BY FIELD(source, ${LOGI_SOURCE_PRIORITY.map(() => '?').join(',')}), article ASC
      LIMIT ?`;
  const limitParam = Math.max(1, Math.min(Number(limit) || 6, 50));
  try {
    return await dbQuery(sql, [...params, ...priorityParams, limitParam]);
  } catch (err) { throw dbError(err, 'logisticsSearch'); }
}

async function listTrucks() {
  try {
    return await dbQuery('SELECT * FROM orch_trucks ORDER BY payload_t ASC, volume_m3 ASC');
  } catch (err) { throw dbError(err, 'listTrucks'); }
}

// ── Прайс: ручные правки активного каталога ─────────────────────────────────
// Активные позиции (active=1) принадлежат последнему импорту. Правки мутируют их
// напрямую и пишут запись в orch_price_changes. Удаление — мягкое (active=0),
// чтобы снимок импорта оставался целым. Новый импорт ФАЙЛА начинает новый снимок
// и стирает ручные правки (это полное обновление прайса; повторный импорт того же
// файла идемпотентен по source_hash и правки НЕ трогает).

// import_id активного каталога поставщика (для добавления позиций в его снимок).
async function priceActiveImportId(q, supplier) {
  const rows = await q('SELECT import_id FROM orch_price_items WHERE active = 1 AND supplier = ? ORDER BY import_id DESC LIMIT 1', [supplier]);
  if (rows.length) return rows[0].import_id;
  const imp = await q("SELECT id FROM orch_price_imports WHERE status = 'ready' AND supplier = ? ORDER BY id DESC LIMIT 1", [supplier]);
  return imp.length ? imp[0].id : null;
}

// Находит активную позицию для правки. Без supplier артикул может совпасть у
// обоих поставщиков → { ambiguous: true } (вызывающий просит уточнить каталог).
async function priceFindForUpdate(q, sku, supplier = null) {
  const normalized = normalizeSku(sku);
  const params = [normalized, String(sku || '').trim()];
  let where = 'active = 1 AND (sku_norm = ? OR UPPER(sku) = UPPER(?))';
  if (supplier) { where += ' AND supplier = ?'; params.push(supplier); }
  const rows = await q(`SELECT * FROM orch_price_items WHERE ${where} ORDER BY supplier ASC LIMIT 2 FOR UPDATE`, params);
  if (!rows.length) return { item: null };
  if (rows.length > 1) return { item: null, ambiguous: true, suppliers: rows.map((r) => r.supplier) };
  return { item: rows[0] };
}

async function priceSetPrice(sku, newPrice, actor = {}, supplier = null) {
  const price = Number(newPrice);
  if (!Number.isFinite(price) || price < 0) return { ok: false, reason: 'invalid_price' };
  try {
    return await withTransaction(async (q) => {
      const found = await priceFindForUpdate(q, sku, supplier);
      if (found.ambiguous) return { ok: false, reason: 'ambiguous_supplier', suppliers: found.suppliers };
      if (!found.item) return { ok: false, reason: 'not_found' };
      const item = found.item;
      const old = Number(item.retail_price);
      await q('UPDATE orch_price_items SET retail_price = ? WHERE id = ?', [price, item.id]);
      await q(
        `INSERT INTO orch_price_changes (price_item_id, sku, supplier, change_type, old_price, new_price, actor_name, note)
         VALUES (?, ?, ?, 'set_price', ?, ?, ?, ?)`,
        [item.id, item.sku, item.supplier, old, price, stockActor(actor), (actor && actor.note) || null]
      );
      return { ok: true, sku: item.sku, supplier: item.supplier, name: item.name, old_price: old, new_price: price, currency: item.currency };
    });
  } catch (err) { throw dbError(err, 'priceSetPrice'); }
}

async function priceSetDiscountPrice(sku, newPrice, actor = {}, supplier = null) {
  const price = Number(newPrice);
  if (!Number.isFinite(price) || price < 0) return { ok: false, reason: 'invalid_price' };
  try {
    return await withTransaction(async (q) => {
      const found = await priceFindForUpdate(q, sku, supplier);
      if (found.ambiguous) return { ok: false, reason: 'ambiguous_supplier', suppliers: found.suppliers };
      if (!found.item) return { ok: false, reason: 'not_found' };
      const item = found.item;
      const old = item.discount_price == null ? null : Number(item.discount_price);
      await q('UPDATE orch_price_items SET discount_price = ? WHERE id = ?', [price, item.id]);
      await q(
        `INSERT INTO orch_price_changes (price_item_id, sku, supplier, change_type, old_discount_price, new_discount_price, actor_name, note)
         VALUES (?, ?, ?, 'set_discount', ?, ?, ?, ?)`,
        [item.id, item.sku, item.supplier, old, price, stockActor(actor), (actor && actor.note) || null]
      );
      return { ok: true, sku: item.sku, supplier: item.supplier, name: item.name, old_discount_price: old, new_discount_price: price, currency: item.currency };
    });
  } catch (err) { throw dbError(err, 'priceSetDiscountPrice'); }
}

async function priceAddItem(data = {}, actor = {}) {
  const { normKey } = require('../utils/stockKey');
  const sku = String(data.sku || '').trim();
  const name = String(data.name || '').trim();
  const supplier = String(data.supplier || '').trim();
  const price = Number(data.retail_price);
  const discount = data.discount_price == null ? null : Number(data.discount_price);
  if (!sku || !name) return { ok: false, reason: 'sku_name_required' };
  if (!supplier) return { ok: false, reason: 'supplier_required' };
  if (!Number.isFinite(price) || price < 0) return { ok: false, reason: 'invalid_price' };
  if (discount != null && (!Number.isFinite(discount) || discount < 0)) return { ok: false, reason: 'invalid_discount_price' };
  const normalized = normalizeSku(sku);
  try {
    return await withTransaction(async (q) => {
      const importId = await priceActiveImportId(q, supplier);
      if (!importId) return { ok: false, reason: 'no_active_catalog' };
      const dup = await q('SELECT id FROM orch_price_items WHERE active = 1 AND supplier = ? AND (sku_norm = ? OR UPPER(sku) = UPPER(?)) LIMIT 1', [supplier, normalized, sku]);
      if (dup.length) return { ok: false, reason: 'exists' };
      const rn = await q('SELECT COALESCE(MAX(row_number), 0) + 1 AS rn FROM orch_price_items WHERE import_id = ?', [importId]);
      const series = data.series || null;
      const loadClass = data.load_class || null;
      const dn = data.dn || null;
      const sourceSku = data.source_sku || null;
      const key = normKey([sku, sourceSku, series, loadClass, name, dn, data.pallet_qty].filter(Boolean).join(' '));
      const res = await q(
        `INSERT INTO orch_price_items
         (import_id, supplier, active, row_number, series_name, sku, source_sku, sku_norm, load_class, name, dn,
          length_mm, width_mm, height_mm, weight_kg, pallet_qty, retail_price, discount_price, currency, norm_key)
         VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [importId, supplier, rn[0].rn, series, sku, sourceSku, normalized, loadClass, name, dn,
          data.length_mm ?? null, data.width_mm ?? null, data.height_mm ?? null, data.weight_kg ?? null,
          data.pallet_qty || null, price, discount, data.currency || 'KZT', key]
      );
      await q(
        `INSERT INTO orch_price_changes (price_item_id, sku, supplier, change_type, new_price, new_discount_price, new_name, actor_name, note)
         VALUES (?, ?, ?, 'add', ?, ?, ?, ?, ?)`,
        [res.insertId, sku, supplier, price, discount, name, stockActor(actor), (actor && actor.note) || null]
      );
      return { ok: true, id: res.insertId, sku, supplier, name, retail_price: price, discount_price: discount, currency: data.currency || 'KZT' };
    });
  } catch (err) { throw dbError(err, 'priceAddItem'); }
}

// Мягкое удаление: active=0 (снимок импорта остаётся целым, история — тоже).
async function priceRemove(sku, actor = {}, supplier = null) {
  try {
    return await withTransaction(async (q) => {
      const found = await priceFindForUpdate(q, sku, supplier);
      if (found.ambiguous) return { ok: false, reason: 'ambiguous_supplier', suppliers: found.suppliers };
      if (!found.item) return { ok: false, reason: 'not_found' };
      const item = found.item;
      await q('UPDATE orch_price_items SET active = 0 WHERE id = ?', [item.id]);
      await q(
        `INSERT INTO orch_price_changes (price_item_id, sku, supplier, change_type, old_price, old_name, actor_name, note)
         VALUES (?, ?, ?, 'remove', ?, ?, ?, ?)`,
        [item.id, item.sku, item.supplier, Number(item.retail_price), item.name, stockActor(actor), (actor && actor.note) || null]
      );
      return { ok: true, sku: item.sku, supplier: item.supplier, name: item.name };
    });
  } catch (err) { throw dbError(err, 'priceRemove'); }
}

async function priceRename(sku, newName, actor = {}, supplier = null) {
  const { normKey } = require('../utils/stockKey');
  const name = String(newName || '').trim();
  if (!name) return { ok: false, reason: 'name_required' };
  try {
    return await withTransaction(async (q) => {
      const found = await priceFindForUpdate(q, sku, supplier);
      if (found.ambiguous) return { ok: false, reason: 'ambiguous_supplier', suppliers: found.suppliers };
      if (!found.item) return { ok: false, reason: 'not_found' };
      const item = found.item;
      const key = normKey([item.sku, item.source_sku, item.series_name, item.load_class, name, item.dn].filter(Boolean).join(' '));
      await q('UPDATE orch_price_items SET name = ?, norm_key = ? WHERE id = ?', [name, key, item.id]);
      await q(
        `INSERT INTO orch_price_changes (price_item_id, sku, supplier, change_type, old_name, new_name, actor_name, note)
         VALUES (?, ?, ?, 'rename', ?, ?, ?, ?)`,
        [item.id, item.sku, item.supplier, item.name, name, stockActor(actor), (actor && actor.note) || null]
      );
      return { ok: true, sku: item.sku, supplier: item.supplier, old_name: item.name, new_name: name };
    });
  } catch (err) { throw dbError(err, 'priceRename'); }
}

async function priceListChanges(sku = null, limit = 50, supplier = null) {
  const where = [];
  const params = [];
  if (sku) { where.push('UPPER(sku) = UPPER(?)'); params.push(String(sku).trim()); }
  if (supplier) { where.push('supplier = ?'); params.push(supplier); }
  params.push(Math.max(1, Math.min(Number(limit) || 50, 100)));
  try {
    return await dbQuery(
      `SELECT id, price_item_id, sku, supplier, change_type, old_price, new_price,
              old_discount_price, new_discount_price, old_name, new_name, actor_name, note, created_at
         FROM orch_price_changes ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY id DESC LIMIT ?`,
      params
    );
  } catch (err) { throw dbError(err, 'priceListChanges'); }
}

// ── Склад: остатки (orch_stock) ─────────────────────────────────────────────
const { normKey, queryTokens } = require('../utils/stockKey');

// Поиск по запросу: каждый токен должен встречаться в norm_key (AND). Без запроса —
// последние позиции. location — опциональный фильтр склада.
async function stockSearch(query, location = null, limit = 50) {
  try {
    const tokens = queryTokens(query);
    const where = [];
    const params = [];
    if (location) { where.push('s.location = ?'); params.push(location); }
    for (const t of tokens) { where.push('s.norm_key LIKE ?'); params.push(`%${t}%`); }
    const sql = `SELECT s.id, s.location, s.name, s.qty, s.unit, s.catalog_item_id, s.updated_at,
                        COALESCE((SELECT SUM(r.qty) FROM orch_stock_reservations r
                                  WHERE r.stock_id = s.id AND r.status = 'active'), 0) AS reserved_qty,
                        s.qty - COALESCE((SELECT SUM(r.qty) FROM orch_stock_reservations r
                                          WHERE r.stock_id = s.id AND r.status = 'active'), 0) AS available_qty
                   FROM orch_stock s`
      + (where.length ? ` WHERE ${where.join(' AND ')}` : '')
      + ` ORDER BY s.name ASC LIMIT ?`;
    params.push(Number(limit) || 50);
    return await dbQuery(sql, params);
  } catch (err) {
    console.error('[MySQL] stockSearch:', err.message);
    return [];
  }
}

async function stockList(location = null, limit = 50) {
  return stockSearch('', location, limit);
}

async function listStockAlerts(limit = 20) {
  return dbQuery(
    `SELECT s.id, s.name, s.qty, s.unit,
            COALESCE(SUM(CASE WHEN r.status = 'active' THEN r.qty ELSE 0 END), 0) AS reserved_qty,
            s.qty - COALESCE(SUM(CASE WHEN r.status = 'active' THEN r.qty ELSE 0 END), 0) AS available_qty
       FROM orch_stock s LEFT JOIN orch_stock_reservations r ON r.stock_id = s.id
      GROUP BY s.id, s.name, s.qty, s.unit
     HAVING reserved_qty > 0 OR available_qty <= 0
      ORDER BY available_qty ASC, s.name ASC LIMIT ?`,
    [Math.max(1, Math.min(Number(limit) || 20, 100))]
  );
}

async function stockGetById(id) {
  try {
    const rows = await dbQuery('SELECT * FROM orch_stock WHERE id = ?', [Number(id)]);
    return rows.length ? rows[0] : null;
  } catch (err) { console.error('[MySQL] stockGetById:', err.message); return null; }
}

async function stockGetByKey(location, key) {
  try {
    const rows = await dbQuery('SELECT * FROM orch_stock WHERE location = ? AND norm_key = ?', [location, key]);
    return rows.length ? rows[0] : null;
  } catch (err) { console.error('[MySQL] stockGetByKey:', err.message); return null; }
}

function stockActor(meta) {
  if (meta && typeof meta === 'object') return String(meta.clientName || meta.chatId || '').slice(0, 120) || null;
  return meta ? String(meta).slice(0, 120) : null;
}

// Установить абсолютный остаток и записать неизменяемое движение.
async function stockUpsertSet(location, name, qty, unit = 'шт', by = null) {
  const loc = location || 'Нижний';
  const key = normKey(name);
  const targetQty = Number(qty);
  if (!Number.isFinite(targetQty) || targetQty < 0) throw new Error('invalid_stock_qty');
  return withTransaction(async (query) => {
    const rows = await query('SELECT * FROM orch_stock WHERE location = ? AND norm_key = ? LIMIT 1 FOR UPDATE', [loc, key]);
    let id;
    let old = 0;
    let created = false;
    if (rows.length) {
      id = rows[0].id;
      old = Number(rows[0].qty);
      await query('UPDATE orch_stock SET name = ?, qty = ?, unit = ?, updated_by = ? WHERE id = ?',
        [String(name), targetQty, unit || rows[0].unit || 'шт', stockActor(by), id]);
    } else {
      const res = await query(
        'INSERT INTO orch_stock (location, name, norm_key, qty, unit, updated_by) VALUES (?, ?, ?, ?, ?, ?)',
        [loc, String(name), key, targetQty, unit || 'шт', stockActor(by)]
      );
      id = res.insertId;
      created = true;
    }
    await query(
      `INSERT INTO orch_stock_movements
       (stock_id, movement_type, qty_delta, balance_after, actor_name, note)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [id, created ? 'opening' : 'set', targetQty - old, targetQty, stockActor(by),
        created ? 'Новая складская позиция' : 'Установка точного остатка']
    );
    return { id, created, old, qty: targetQty };
  });
}

async function stockMovement(stockId, type, quantity, meta = {}) {
  const qty = Math.abs(Number(quantity));
  if (!Number.isFinite(qty) || qty <= 0) return { ok: false, reason: 'invalid_qty' };
  const sign = type === 'receive' ? 1 : -1;
  if (!['receive', 'issue'].includes(type)) return { ok: false, reason: 'invalid_type' };
  return withTransaction(async (q) => {
    const rows = await q('SELECT * FROM orch_stock WHERE id = ? LIMIT 1 FOR UPDATE', [stockId]);
    if (!rows.length) return { ok: false, reason: 'not_found' };
    const row = rows[0];
    const reservedRows = await q(
      "SELECT id, qty FROM orch_stock_reservations WHERE stock_id = ? AND status = 'active' FOR UPDATE",
      [stockId]
    );
    const reserved = reservedRows.reduce((sum, r) => sum + Number(r.qty), 0);
    const old = Number(row.qty);
    const available = old - reserved;
    if (sign < 0 && qty > available) return { ok: false, reason: 'insufficient_available', old, reserved, available };
    const next = old + sign * qty;
    await q('UPDATE orch_stock SET qty = ?, updated_by = ? WHERE id = ?', [next, stockActor(meta), stockId]);
    const movement = await q(
      `INSERT INTO orch_stock_movements
       (stock_id, movement_type, qty_delta, balance_after, object_ref, project_id, task_id, actor_name, note)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [stockId, type, sign * qty, next, meta.object_ref || null, meta.project_id || null,
        meta.task_id || null, stockActor(meta), meta.note || null]
    );
    return { ok: true, movement_id: movement.insertId, old, qty: next, reserved, available: next - reserved };
  });
}

async function stockAdjust(row, delta, by = null) {
  if (!row) return { ok: false, reason: 'not_found' };
  const d = Number(delta);
  return stockMovement(row.id, d >= 0 ? 'receive' : 'issue', Math.abs(d),
    by && typeof by === 'object' ? by : { clientName: by });
}

async function stockReserve(stockId, quantity, meta = {}) {
  const qty = Number(quantity);
  if (!Number.isFinite(qty) || qty <= 0) return { ok: false, reason: 'invalid_qty' };
  return withTransaction(async (q) => {
    const rows = await q('SELECT * FROM orch_stock WHERE id = ? LIMIT 1 FOR UPDATE', [stockId]);
    if (!rows.length) return { ok: false, reason: 'not_found' };
    const reservedRows = await q(
      "SELECT id, qty FROM orch_stock_reservations WHERE stock_id = ? AND status = 'active' FOR UPDATE",
      [stockId]
    );
    const reserved = reservedRows.reduce((sum, r) => sum + Number(r.qty), 0);
    const available = Number(rows[0].qty) - reserved;
    if (qty > available) return { ok: false, reason: 'insufficient_available', available, reserved };
    const res = await q(
      `INSERT INTO orch_stock_reservations
       (stock_id, qty, object_ref, project_id, task_id, actor_name, note)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [stockId, qty, meta.object_ref || null, meta.project_id || null, meta.task_id || null,
        stockActor(meta), meta.note || null]
    );
    return { ok: true, reservation_id: res.insertId, qty, reserved: reserved + qty, available: available - qty };
  });
}

async function stockReleaseReservation(reservationId, consume = false, meta = {}) {
  return withTransaction(async (q) => {
    const rows = await q('SELECT * FROM orch_stock_reservations WHERE id = ? LIMIT 1 FOR UPDATE', [reservationId]);
    if (!rows.length) return { ok: false, reason: 'not_found' };
    const reservation = rows[0];
    if (reservation.status !== 'active') return { ok: false, reason: 'not_active', status: reservation.status };
    let balance = null;
    if (consume) {
      const stockRows = await q('SELECT qty FROM orch_stock WHERE id = ? LIMIT 1 FOR UPDATE', [reservation.stock_id]);
      if (!stockRows.length || Number(stockRows[0].qty) < Number(reservation.qty)) return { ok: false, reason: 'insufficient_on_hand' };
      balance = Number(stockRows[0].qty) - Number(reservation.qty);
      await q('UPDATE orch_stock SET qty = ?, updated_by = ? WHERE id = ?', [balance, stockActor(meta), reservation.stock_id]);
      await q(
        `INSERT INTO orch_stock_movements
         (stock_id, movement_type, qty_delta, balance_after, object_ref, project_id, task_id, actor_name, note)
         VALUES (?, 'issue', ?, ?, ?, ?, ?, ?, ?)`,
        [reservation.stock_id, -Number(reservation.qty), balance, reservation.object_ref,
          reservation.project_id, reservation.task_id, stockActor(meta), meta.note || 'Списание резерва']
      );
    }
    await q('UPDATE orch_stock_reservations SET status = ? WHERE id = ?', [consume ? 'consumed' : 'released', reservationId]);
    return { ok: true, reservation_id: Number(reservationId), status: consume ? 'consumed' : 'released', balance };
  });
}

async function stockListMovements(stockId, limit = 50) {
  return dbQuery(
    'SELECT * FROM orch_stock_movements WHERE stock_id = ? ORDER BY id DESC LIMIT ?',
    [Number(stockId), Math.max(1, Math.min(Number(limit) || 50, 100))]
  );
}

async function stockLinkCatalog(stockId, sku, supplier = null) {
  const rows = await priceGetBySku(sku, supplier);
  if (!rows.length) return { ok: false, reason: 'sku_not_found' };
  // Артикул есть в обоих каталогах → нужен supplier, молча не выбираем.
  if (rows.length > 1) return { ok: false, reason: 'ambiguous_supplier', suppliers: rows.map((r) => r.supplier) };
  const item = rows[0];
  const res = await dbQuery('UPDATE orch_stock SET catalog_item_id = ? WHERE id = ?', [item.id, Number(stockId)]);
  if (!(res.affectedRows || 0)) return { ok: false, reason: 'stock_not_found' };
  return { ok: true, stock_id: Number(stockId), catalog_item_id: item.id, sku: item.sku, supplier: item.supplier };
}

async function stockRemove(id) {
  try {
    const res = await dbQuery('DELETE FROM orch_stock WHERE id = ?', [Number(id)]);
    return res && (res.affectedRows || 0) > 0;
  } catch (err) { console.error('[MySQL] stockRemove:', err.message); return false; }
}

async function stockRename(id, newName, by = null) {
  try {
    const res = await dbQuery(
      'UPDATE orch_stock SET name = ?, norm_key = ?, updated_by = ? WHERE id = ?',
      [String(newName), normKey(newName), by, Number(id)]
    );
    return res && (res.affectedRows || 0) > 0;
  } catch (err) { console.error('[MySQL] stockRename:', err.message); return false; }
}

module.exports = {
  getPool, dbQuery, withTransaction, initTables, _mergeHistory,
  loadHistory, saveHistory, clearHistory,
  // Долгая память: архив переписки + журнал действий + recall
  archiveMessage, logBotEvent, recallSearch, archiveByDateRange, archiveByPerson,
  // Семантический индекс архива (RAG)
  listChatsWithBacklog, archiveMessagesAfter, insertArchiveChunk, loadChunkVectors,
  checkDailyCount, incrementDailyCount,
  // Оркестратор: сотрудники
  seedEmployees, listEmployees, findEmployeeByContact, getEmployeeById, getOpenTasksForEmployee,
  getLatestProjectForEmployee, findBossRoute, addEmployee, updateEmployee, deactivateEmployee, findEmployees,
  getActiveEmployeeIdSet,
  // Оркестратор: проекты
  createProject, getProject, updateProjectPlan, setProjectStatus, recomputeProjectStatus,
  listProjectsForOwner, listAllProjects, listOpenTasksBrief,
  getSettings, setSetting,
  createSchedule, listEnabledSchedules, listSchedulesByOwner, getSchedule,
  updateSchedule, setScheduleEnabled, deleteSchedule,
  markScheduleRun, claimSchedule, setScheduleNextRun, touchScheduleStatus, bumpScheduleFail, countSchedules,
  logScheduleRun, listScheduleRuns, cleanupScheduleRuns,
  getEmployeePeriodStats,
  addFact, listFacts, deleteFact,
  addPersonalItem, listPersonalItems, setPersonalItemDone, deletePersonalItem,
  setQuiet, clearQuiet, getQuiet, listActiveQuiet,
  setChatPrivacy, getChatPrivacy,
  // База знаний по файлам
  replaceFile, listFiles, findFile, deleteFile, clearFiles, setFileVisibility, renameFile,
  loadFileChunkVectors, fileKeywordSearch,
  // Оркестратор: задачи
  createTasksBulk, getTask, listTasksForProject, assignTask, markDispatched, updateTaskStatus,
  updateTaskFields,
  setTaskDeadline, createTaskReport, listTaskEvents,
  // Ops / обратная связь
  createOpsEvent, listPendingOpsEvents, markOpsEventDelivered, markOpsEventAttempt,
  // Прайс
  importPriceCatalog, priceGetBySku, priceSearch,
  priceSetPrice, priceSetDiscountPrice, priceAddItem, priceRemove, priceRename, priceListChanges,
  // Логистика/паллетировка (отдельная справочная база)
  importLogistics, logisticsGetByArticle, logisticsSearch, listTrucks,
  // Склад: остатки
  stockSearch, stockList, stockGetById, stockGetByKey, stockUpsertSet, stockAdjust,
  listStockAlerts,
  stockMovement, stockReserve, stockReleaseReservation, stockListMovements,
  stockLinkCatalog,
  stockRemove, stockRename,
};

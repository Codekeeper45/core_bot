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
    'SELECT next_run_at, fire_phase, nag_interval_min, until_at, run_count, watch_task_id, watch_goal FROM orch_schedules LIMIT 0',
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
// Если файла нет и таблица пуста — fallback на 5 тестовых сотрудников.
const SEED_EMPLOYEES = [
  { name: 'Aida Sorokina',  roles: 'research,analytics',   skills: 'исследование рынка и конкурентов, синтез данных, аналитика, отчётность' },
  { name: 'Timur Bekov',    roles: 'backend,devops',       skills: 'Node.js API, MySQL, CI/CD, деплой, инфраструктура' },
  { name: 'Lena Park',      roles: 'frontend,design',      skills: 'UI/UX, React, прототипирование, тексты для экранов' },
  { name: 'Marat Iskakov',  roles: 'qa,docs',              skills: 'тест-планы, регрессия, техническая документация, runbook' },
  { name: 'Dana Yusupova',  roles: 'pm,comms,backend',     skills: 'координация, коммуникация со стейкхолдерами, планирование, лёгкий бэкенд' },
];

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

    // Файла нет: если таблица совсем пуста — fallback на тестовых.
    const any = await dbQuery('SELECT COUNT(*) AS c FROM orch_employees');
    if (any[0] && Number(any[0].c) > 0) return;
    for (const e of SEED_EMPLOYEES) {
      await dbQuery(
        'INSERT INTO orch_employees (name, roles, skills, channel, contact) VALUES (?, ?, ?, NULL, NULL)',
        [e.name, e.roles, e.skills]
      );
    }
    console.log(`[MySQL] Seeded ${SEED_EMPLOYEES.length} test employees (Excel не найден)`);
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
                WHERE t.assignee_id = e.id AND t.status NOT IN ('done')) AS open_task_count
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
       WHERE assignee_id = ? AND status NOT IN ('done') ORDER BY priority ASC, id ASC`,
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
    await dbQuery('UPDATE orch_projects SET plan = ? WHERE id = ?', [plan, id]);
  } catch (err) {
    console.error('[MySQL] updateProjectPlan:', err.message);
  }
}

async function setProjectStatus(id, status) {
  try {
    await dbQuery('UPDATE orch_projects SET status = ? WHERE id = ?', [status, id]);
  } catch (err) {
    console.error('[MySQL] setProjectStatus:', err.message);
  }
}

// Пересчитывает статус проекта ОДНИМ агрегатом (без read-modify-write на стороне
// Node — это убирает гонку, когда несколько сотрудников отчитываются одновременно).
// done — если все задачи done; blocked — если есть заблокированные; иначе active.
// Возвращает выставленный статус (или null при сбое).
async function recomputeProjectStatus(projectId) {
  try {
    const rows = await dbQuery(
      `SELECT COUNT(*) AS total,
              SUM(status = 'done')    AS done,
              SUM(status = 'blocked') AS blocked
         FROM orch_tasks WHERE project_id = ?`,
      [projectId]
    );
    const r = rows[0] || {};
    const status = rollupStatus({
      total: Number(r.total) || 0,
      done: Number(r.done) || 0,
      blocked: Number(r.blocked) || 0,
    });
    await dbQuery('UPDATE orch_projects SET status = ? WHERE id = ?', [status, projectId]);
    return status;
  } catch (err) {
    console.error('[MySQL] recomputeProjectStatus:', err.message);
    return null;
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
              COALESCE(SUM(t.created_at >= ? AND t.created_at < ?), 0)                          AS assigned,
              COALESCE(SUM(t.created_at >= ? AND t.created_at < ? AND t.status = 'done'), 0)    AS assigned_done,
              COALESCE(SUM(t.completed_at >= ? AND t.completed_at < ?), 0)                      AS done_total,
              COALESCE(SUM(t.completed_at >= ? AND t.completed_at < ?
                           AND t.deadline IS NOT NULL AND t.completed_at > t.deadline), 0)      AS done_late,
              COALESCE(SUM(t.status NOT IN ('done')
                           AND t.deadline IS NOT NULL AND t.deadline < ?), 0)                   AS open_overdue,
              COALESCE(SUM(t.status = 'blocked'), 0)                                            AS blocked_now,
              AVG(CASE WHEN t.completed_at >= ? AND t.completed_at < ? AND t.dispatched_at IS NOT NULL
                       THEN TIMESTAMPDIFF(HOUR, t.dispatched_at, t.completed_at) END)           AS avg_hours
       FROM orch_employees e
       LEFT JOIN orch_tasks t ON t.assignee_id = e.id
       WHERE e.active = 1
       GROUP BY e.id, e.name, e.roles
       ORDER BY e.id ASC`,
      [from, to, from, to, from, to, from, to, to, from, to]
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
      `SELECT id, title, project_id, status, assignee_id, updated_at
       FROM orch_tasks WHERE status NOT IN ('done')
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
// tasksArray: [{ ref, title, description, expected, priority, depends_on:[ref], assignee_id }]
// Возвращает массив [{ ref, id, title }] (карта временных ref → реальных id), плюс
// свойство .warnings — что было исправлено (невалидный исполнитель, неизвестная
// зависимость, отброшенное цикл-ребро). Вставка и wiring зависимостей атомарны.
async function createTasksBulk(projectId, tasksArray) {
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
        `INSERT INTO orch_tasks (project_id, title, description, expected, priority, assignee_id)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
          projectId,
          String(t.title || '').slice(0, 255),
          t.description || null,
          t.expected || null,
          Number.isInteger(t.priority) ? t.priority : 3,
          t.assignee_id || null,
        ]
      );
      const id = rows.insertId;
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
async function assignTask(taskId, employeeId) {
  try {
    await dbQuery(
      `UPDATE orch_tasks
         SET assignee_id = ?,
             dispatched = 0,
             sent = 0,
             dispatched_at = CASE WHEN status IN ('dispatched','done','blocked') THEN NULL ELSE dispatched_at END,
             completed_at  = CASE WHEN status = 'done' THEN NULL ELSE completed_at END,
             status = CASE WHEN status IN ('dispatched','done','blocked') THEN 'todo' ELSE status END
       WHERE id = ?`,
      [employeeId, taskId]
    );
    const rows = await dbQuery('SELECT status FROM orch_tasks WHERE id = ? LIMIT 1', [taskId]);
    return rows.length ? rows[0].status : null;
  } catch (err) {
    console.error('[MySQL] assignTask:', err.message);
    return null;
  }
}

// Точечная правка полей задачи (revise_project edit_tasks). Только whitelist-
// колонки; переназначение исполнителя делает assignTask (со сбросом диспатча).
async function updateTaskFields(taskId, fields = {}) {
  const ALLOWED = ['title', 'description', 'expected', 'priority', 'deadline'];
  const sets = [];
  const vals = [];
  for (const col of ALLOWED) {
    if (fields[col] !== undefined) { sets.push(`${col} = ?`); vals.push(fields[col]); }
  }
  if (!sets.length) return false;
  try {
    vals.push(taskId);
    await dbQuery(`UPDATE orch_tasks SET ${sets.join(', ')} WHERE id = ?`, vals);
    return true;
  } catch (err) {
    console.error('[MySQL] updateTaskFields:', err.message);
    return false;
  }
}

async function markDispatched(taskId, sent) {
  try {
    // dispatched_at ставим один раз (COALESCE), чтобы метрика времени была корректной.
    await dbQuery(
      `UPDATE orch_tasks
         SET dispatched = 1, sent = ?, status = 'dispatched',
             dispatched_at = COALESCE(dispatched_at, NOW())
       WHERE id = ?`,
      [sent ? 1 : 0, taskId]
    );
  } catch (err) {
    console.error('[MySQL] markDispatched:', err.message);
  }
}

async function updateTaskStatus(taskId, status, result) {
  try {
    // completed_at проставляем ТОЛЬКО при переходе в done (write-once через COALESCE).
    // При любом другом статусе completed_at НЕ трогаем — иначе возврат задачи на
    // доработку (done → in_progress → done) затирал бы исторический тайминг и портил
    // метрики времени выполнения. Реальный «reopen» выполняет assignTask.
    const setCompleted = status === 'done' ? ', completed_at = COALESCE(completed_at, NOW())' : '';
    if (result !== undefined && result !== null) {
      await dbQuery(
        `UPDATE orch_tasks SET status = ?, result = ?${setCompleted} WHERE id = ?`,
        [status, result, taskId]
      );
    } else {
      await dbQuery(
        `UPDATE orch_tasks SET status = ?${setCompleted} WHERE id = ?`,
        [status, taskId]
      );
    }
  } catch (err) {
    console.error('[MySQL] updateTaskStatus:', err.message);
  }
}

async function setTaskDeadline(taskId, deadline) {
  try {
    await dbQuery('UPDATE orch_tasks SET deadline = ? WHERE id = ?', [deadline, taskId]);
  } catch (err) {
    console.error('[MySQL] setTaskDeadline:', err.message);
  }
}

// ─── Chat history ─────────────────────────────────────────────────────────────
async function loadHistory(channel, chatId) {
  try {
    const rows = await dbQuery(
      'SELECT messages, summary FROM bot_chat_history WHERE channel = ? AND chat_id = ?',
      [channel, chatId]
    );
    if (!rows.length) return { summary: '', messages: [] };
    return { summary: rows[0].summary || '', messages: JSON.parse(rows[0].messages) };
  } catch (err) {
    console.error('[MySQL] loadHistory:', err.message);
    return { summary: '', messages: [] };
  }
}

async function saveHistory(channel, chatId, messages, summary = '') {
  try {
    // Backstop only — contextManager keeps the array well under this via summarization.
    // Режем по ЧИСТОЙ границе хода: иначе обрезанный массив может начаться с
    // осиротевшего role:'tool' → API 400 на каждом следующем сообщении (чат залипает).
    const { safeTrimHistory } = require('../agent/contextManager');
    const trimmed = safeTrimHistory(messages, config.CHAT_MEMORY_WINDOW);
    await dbQuery(
      `INSERT INTO bot_chat_history (channel, chat_id, messages, summary)
       VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE messages = VALUES(messages), summary = VALUES(summary)`,
      [channel, chatId, JSON.stringify(trimmed), summary || null]
    );
  } catch (err) {
    console.error('[MySQL] saveHistory:', err.message);
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


// ── Склад: остатки (orch_stock) ─────────────────────────────────────────────
const { normKey, queryTokens } = require('../utils/stockKey');

// Поиск по запросу: каждый токен должен встречаться в norm_key (AND). Без запроса —
// последние позиции. location — опциональный фильтр склада.
async function stockSearch(query, location = null, limit = 50) {
  try {
    const tokens = queryTokens(query);
    const where = [];
    const params = [];
    if (location) { where.push('location = ?'); params.push(location); }
    for (const t of tokens) { where.push('norm_key LIKE ?'); params.push(`%${t}%`); }
    const sql = `SELECT id, location, name, qty, unit, updated_at FROM orch_stock`
      + (where.length ? ` WHERE ${where.join(' AND ')}` : '')
      + ` ORDER BY name ASC LIMIT ?`;
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

// Установить абсолютный остаток (создаёт позицию, если её не было). Возвращает
// { id, created, qty }.
async function stockUpsertSet(location, name, qty, unit = 'шт', by = null) {
  const loc = location || 'Нижний';
  const key = normKey(name);
  const q = Number(qty);
  await dbQuery(
    `INSERT INTO orch_stock (location, name, norm_key, qty, unit, updated_by)
     VALUES (?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE qty = VALUES(qty), name = VALUES(name),
       unit = VALUES(unit), updated_by = VALUES(updated_by)`,
    [loc, String(name), key, q, unit || 'шт', by]
  );
  const row = await stockGetByKey(loc, key);
  return { id: row ? row.id : null, created: !!row, qty: row ? Number(row.qty) : q };
}

// Приход(+)/расход(−) по существующей позиции. Остаток не уходит ниже 0 (clamp).
// Возвращает { ok, old, qty, clamped } или { ok:false } если позиция не найдена.
async function stockAdjust(row, delta, by = null) {
  if (!row) return { ok: false };
  const old = Number(row.qty);
  let next = old + Number(delta);
  let clamped = false;
  if (next < 0) { next = 0; clamped = true; }
  await dbQuery('UPDATE orch_stock SET qty = ?, updated_by = ? WHERE id = ?', [next, by, row.id]);
  return { ok: true, old, qty: next, clamped };
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
  getPool, dbQuery, withTransaction, initTables,
  loadHistory, saveHistory, clearHistory,
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
  // Оркестратор: задачи
  createTasksBulk, getTask, listTasksForProject, assignTask, markDispatched, updateTaskStatus,
  updateTaskFields,
  setTaskDeadline,
  // Склад: остатки
  stockSearch, stockList, stockGetById, stockGetByKey, stockUpsertSet, stockAdjust,
  stockRemove, stockRename,
};

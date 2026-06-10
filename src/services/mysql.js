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


module.exports = {
  getPool, dbQuery, withTransaction, initTables,
  loadHistory, saveHistory, clearHistory,
  checkDailyCount, incrementDailyCount,
  // Оркестратор: сотрудники
  seedEmployees, listEmployees, findEmployeeByContact, getEmployeeById, getOpenTasksForEmployee,
  getLatestProjectForEmployee, addEmployee, updateEmployee, deactivateEmployee, findEmployees,
  getActiveEmployeeIdSet,
  // Оркестратор: проекты
  createProject, getProject, updateProjectPlan, setProjectStatus, recomputeProjectStatus,
  listProjectsForOwner, listAllProjects, listOpenTasksBrief,
  getSettings, setSetting,
  // Оркестратор: задачи
  createTasksBulk, getTask, listTasksForProject, assignTask, markDispatched, updateTaskStatus,
  setTaskDeadline,
};

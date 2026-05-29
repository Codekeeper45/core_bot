'use strict';
const mysql = require('mysql2/promise');
const config = require('../config');

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

  // Состояние handoff (пауза бота, менеджер берёт диалог)
  await dbQuery(`
    CREATE TABLE IF NOT EXISTS bot_handoff_state (
      channel     VARCHAR(20)  NOT NULL,
      chat_id     VARCHAR(255) NOT NULL,
      data        TEXT         NOT NULL,
      expires_at  DATETIME     NOT NULL,
      PRIMARY KEY (channel, chat_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  // Сообщения, пришедшие пока бот на паузе
  await dbQuery(`
    CREATE TABLE IF NOT EXISTS bot_handoff_history (
      id         INT AUTO_INCREMENT PRIMARY KEY,
      channel    VARCHAR(20)  NOT NULL,
      chat_id    VARCHAR(255) NOT NULL,
      ts         VARCHAR(50)  NOT NULL,
      message    TEXT         NOT NULL,
      created_at TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_hh (channel, chat_id)
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

  console.log('[MySQL] Tables ready');
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
    const trimmed = messages.slice(-config.CHAT_MEMORY_WINDOW);
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

// ─── Handoff state ────────────────────────────────────────────────────────────
async function getHandoff(channel, chatId) {
  try {
    const rows = await dbQuery(
      'SELECT data FROM bot_handoff_state WHERE channel = ? AND chat_id = ? AND expires_at > NOW()',
      [channel, chatId]
    );
    if (!rows.length) return null;
    return JSON.parse(rows[0].data);
  } catch (err) {
    console.error('[MySQL] getHandoff:', err.message);
    return null;
  }
}

async function setHandoff(channel, chatId, data, ttlSeconds) {
  try {
    await dbQuery(
      `INSERT INTO bot_handoff_state (channel, chat_id, data, expires_at)
       VALUES (?, ?, ?, DATE_ADD(NOW(), INTERVAL ? SECOND))
       ON DUPLICATE KEY UPDATE data = VALUES(data), expires_at = VALUES(expires_at)`,
      [channel, chatId, JSON.stringify(data), ttlSeconds]
    );
  } catch (err) {
    console.error('[MySQL] setHandoff:', err.message);
  }
}

async function clearHandoff(channel, chatId) {
  try {
    await dbQuery('DELETE FROM bot_handoff_state WHERE channel = ? AND chat_id = ?', [channel, chatId]);
  } catch (err) {
    console.error('[MySQL] clearHandoff:', err.message);
  }
}

// ─── Handoff history (messages while bot is paused) ──────────────────────────
async function appendHandoffHistory(channel, chatId, message) {
  try {
    // Extend handoff TTL when client writes during pause
    await dbQuery(
      `UPDATE bot_handoff_state SET expires_at = DATE_ADD(NOW(), INTERVAL ? SECOND)
       WHERE channel = ? AND chat_id = ?`,
      [config.HANDOFF_TTL, channel, chatId]
    );
    await dbQuery(
      'INSERT INTO bot_handoff_history (channel, chat_id, ts, message) VALUES (?, ?, ?, ?)',
      [channel, chatId, new Date().toISOString(), message]
    );
  } catch (err) {
    console.error('[MySQL] appendHandoffHistory:', err.message);
  }
}

async function getAndClearHandoffHistory(channel, chatId) {
  try {
    const rows = await dbQuery(
      'SELECT ts, message FROM bot_handoff_history WHERE channel = ? AND chat_id = ? ORDER BY id ASC',
      [channel, chatId]
    );
    if (rows.length) {
      await dbQuery('DELETE FROM bot_handoff_history WHERE channel = ? AND chat_id = ?', [channel, chatId]);
    }
    return rows;
  } catch (err) {
    console.error('[MySQL] getAndClearHandoffHistory:', err.message);
    return [];
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
  getPool, dbQuery, initTables,
  loadHistory, saveHistory,
  getHandoff, setHandoff, clearHandoff,
  appendHandoffHistory, getAndClearHandoffHistory,
  checkDailyCount, incrementDailyCount,
};

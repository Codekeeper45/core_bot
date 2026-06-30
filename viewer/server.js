'use strict';
// Локальный read-only вьювер чатов бота. Запуск: node viewer/server.js
// Слушает ТОЛЬКО 127.0.0.1 — наружу не торчит. Делает только SELECT.
require('dotenv').config();
const path = require('path');
const express = require('express');
const mysql = require('mysql2/promise');
const { cleanMessages, previewOf, resolveName, empKey } = require('./lib');

const PORT = parseInt(process.env.VIEWER_PORT || '3030', 10);

const pool = mysql.createPool({
  host: process.env.MYSQL_HOST,
  port: parseInt(process.env.MYSQL_PORT || '3306', 10),
  user: process.env.MYSQL_USER,
  password: process.env.MYSQL_PASSWORD,
  database: process.env.MYSQL_DATABASE,
  connectionLimit: 4,
  charset: 'utf8mb4',
});

// Карта сотрудников канал+контакт → имя (для подписи чатов своими именами).
async function loadEmployeeMap() {
  const map = new Map();
  try {
    const [rows] = await pool.query('SELECT name, channel, contact FROM orch_employees WHERE contact IS NOT NULL');
    for (const r of rows) {
      if (r.channel && r.contact) map.set(empKey(r.channel, r.contact), r.name);
    }
  } catch (_) { /* нет таблицы/доступа — просто без имён */ }
  return map;
}

function parseMessages(blob) {
  try { const v = JSON.parse(blob); return Array.isArray(v) ? v : []; }
  catch (_) { return []; }
}

const app = express();

app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'index.html')));

// Список чатов (без полных сообщений — только превью).
app.get('/api/chats', async (_req, res) => {
  try {
    const empMap = await loadEmployeeMap();
    const [rows] = await pool.query(
      'SELECT channel, chat_id, summary, updated_at, messages FROM bot_chat_history ORDER BY updated_at DESC'
    );
    const chats = rows.map((r) => {
      const pv = previewOf(parseMessages(r.messages));
      return {
        channel: r.channel,
        chat_id: r.chat_id,
        name: resolveName(r.channel, r.chat_id, empMap),
        updated_at: r.updated_at,
        has_summary: !!(r.summary && r.summary.trim()),
        count: pv.count,
        last: pv.last,
      };
    });
    res.json({ chats });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Одна переписка целиком.
app.get('/api/chat', async (req, res) => {
  const { channel, chat_id } = req.query;
  if (!channel || !chat_id) return res.status(400).json({ error: 'нужны channel и chat_id' });
  try {
    const empMap = await loadEmployeeMap();
    const [rows] = await pool.query(
      'SELECT channel, chat_id, summary, updated_at, messages FROM bot_chat_history WHERE channel = ? AND chat_id = ? LIMIT 1',
      [String(channel), String(chat_id)]
    );
    if (!rows.length) return res.status(404).json({ error: 'чат не найден' });
    const r = rows[0];
    res.json({
      channel: r.channel,
      chat_id: r.chat_id,
      name: resolveName(r.channel, r.chat_id, empMap),
      updated_at: r.updated_at,
      summary: r.summary || '',
      messages: cleanMessages(parseMessages(r.messages)),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, '127.0.0.1', () => {
  console.log(`[Viewer] Читалка чатов: http://localhost:${PORT}  (только localhost, только чтение)`);
  if (!process.env.MYSQL_HOST) console.warn('[Viewer] MYSQL_HOST не задан — проверь .env');
});

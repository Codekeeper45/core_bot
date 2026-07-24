'use strict';
// Планировщик отчётов — ежедневные ритуалы компании (см. orchestrator_learning_patterns.md):
//  - ВЕЧЕРОМ (eveningHour) каждому сотруднику с открытыми задачами уходит
//    персональное напоминание отписаться по задачам (ответ обработает обычный
//    пайплайн в режиме EMPLOYEE CONTEXT → update_task).
//  - УТРОМ (morningHour) боссу уходит сводка: нагрузка, блокеры,
//    задачи без движения 2+ дня.
// Воскресенье — выходной. Время локальное (SCHEDULER_TZ_OFFSET_MIN, Казахстан UTC+5).
// Дедупликация — по дате последнего запуска каждой джобы (в памяти процесса).
//
// УПРАВЛЕНИЕ: ИИ управляет планировщиком через инструмент manage_scheduler
// (вкл/выкл, смена часов, запуск вручную). Изменения сохраняются в orch_settings
// и переживают рестарт: env-значения — только дефолт при первом старте.
const config = require('../config');
const { listEmployees, listOpenTasksBrief, listStockAlerts, getSettings, setSetting, listActiveQuiet } = require('./mysql');
const notifier = require('./notifier');

// Кому сейчас нельзя писать первым (тихий режим) — по нормализованному телефону.
async function quietDigitsSet() {
  try {
    const rows = await listActiveQuiet();
    return new Set(rows.map((q) => String(q.owner_phone || '').replace(/\D/g, '')).filter(Boolean));
  } catch (_) {
    return new Set();
  }
}

const STATUS_RU = {
  new: 'не взята',
  todo: 'не взята',
  dispatched: 'ожидает',
  in_progress: 'в работе',
  blocked: 'блокер',
};

const STALE_DAYS = 2;       // «без движения» = updated_at старше этого
const MAX_LINES = 10;       // не раздувать сообщение сотруднику

// Рантайм-состояние (дефолты из env, переопределения из orch_settings).
const state = {
  enabled: config.SCHEDULER_ENABLED,
  morningHour: config.MORNING_SUMMARY_HOUR,
  eveningHour: config.EVENING_REPORT_HOUR,
};

// «Юрин Владимир» → «Владимир»; «Али» → «Али» (в реестре формат «Фамилия Имя»).
function firstName(name) {
  const parts = String(name || '').trim().split(/\s+/);
  return parts.length > 1 ? parts[1] : (parts[0] || '');
}

function localNow(now, tzOffsetMin) {
  const off = (tzOffsetMin === undefined) ? config.SCHEDULER_TZ_OFFSET_MIN : tzOffsetMin;
  return new Date(now.getTime() + off * 60000);
}

// Состояние «когда джоба успешно отстрелялась» (ключ = локальная дата YYYY-MM-DD).
// Персистится в orch_settings, чтобы рестарт не дублировал и не терял рассылку.
const lastRun = { morning: '', evening: '', group_summary: '' };

function localDateKey(now = new Date()) {
  return localNow(now).toISOString().slice(0, 10);
}

// true, если джобу пора запускать: будний день, локальное время уже >= часа,
// и сегодня она ещё НЕ выполнялась успешно. Без side-effect — отметку ставит
// markDone ПОСЛЕ успешной отправки (поэтому сбой/ранний рестарт не теряет день).
function shouldFire(job, hour, now = new Date(), st = lastRun) {
  const loc = localNow(now);
  if (loc.getUTCDay() === 0) return false;          // воскресенье — выходной
  if (loc.getUTCHours() < hour) return false;       // ещё не наступил час (с досылом при позднем старте)
  if (st[job] === localDateKey(now)) return false;  // уже сделано сегодня
  return true;
}

async function markDone(job, now = new Date()) {
  const key = localDateKey(now);
  lastRun[job] = key;
  await setSetting(`scheduler.last_${job}`, key);
}

// ── Вечер: персональные напоминания исполнителям ──────────────────────────
function buildEveningReminders(employees, tasks) {
  const byAssignee = new Map();
  for (const t of tasks) {
    if (!t.assignee_id) continue;
    if (!byAssignee.has(t.assignee_id)) byAssignee.set(t.assignee_id, []);
    byAssignee.get(t.assignee_id).push(t);
  }
  const out = [];
  for (const e of employees) {
    const list = byAssignee.get(e.id);
    if (!list || !list.length || !e.contact) continue;
    const lines = list.slice(0, MAX_LINES)
      .map((t) => `- №${t.id} «${t.title}» (${STATUS_RU[t.status] || t.status})`);
    const more = list.length > MAX_LINES ? `\n…и ещё ${list.length - MAX_LINES}` : '';
    out.push({
      employee: e,
      text: 'Конец дня — отпишись по задачам:\n'
        + `${lines.join('\n')}${more}\n`
        + 'Ответь по номерам, например: «№10 — в работе, сделано 70%, дальше упаковка» или «№11 — блокер: нет машины».',
    });
  }
  return out;
}

async function runEveningReminders() {
  const [employees, tasks] = await Promise.all([listEmployees(), listOpenTasksBrief()]);
  const reminders = buildEveningReminders(employees, tasks);
  const quiet = await quietDigitsSet();
  let sent = 0;
  for (const r of reminders) {
    // Тихий режим сотрудника — вечернее напоминание ему не шлём.
    if (quiet.has(String(r.employee.contact || '').replace(/\D/g, ''))) continue;
    const ok = await notifier.deliver(r.employee.channel || 'whatsapp', r.employee.contact, r.text);
    if (ok) sent += 1;
  }
  console.log(`[Scheduler] Вечерний сбор статусов: ${sent}/${reminders.length} отправлено`);
  return { sent, total: reminders.length };
}

// ── Утро: сводка боссу ─────────────────────────────────────────────────────
function buildMorningSummary(tasks, employees, now = new Date(), stockAlerts = []) {
  if (!tasks.length) return 'Доброе утро. Открытых задач нет.';

  const nameById = new Map(employees.map((e) => [e.id, firstName(e.name)]));
  const who = (id) => nameById.get(id) || (id ? `сотрудник №${id}` : 'без исполнителя');

  const counts = { in_progress: 0, blocked: 0, waiting: 0 };
  for (const t of tasks) {
    if (t.status === 'in_progress') counts.in_progress += 1;
    else if (t.status === 'blocked') counts.blocked += 1;
    else counts.waiting += 1;
  }

  const staleMs = STALE_DAYS * 24 * 3600 * 1000;
  const stale = tasks.filter((t) => t.status !== 'blocked' && t.updated_at
    && (now.getTime() - new Date(t.updated_at).getTime()) >= staleMs);
  const blocked = tasks.filter((t) => t.status === 'blocked');
  const overdue = tasks.filter((t) => t.deadline && new Date(t.deadline).getTime() < now.getTime());
  const todayKey = localDateKey(now);
  const dueToday = tasks.filter((t) => t.deadline && !overdue.includes(t)
    && localDateKey(new Date(t.deadline)) === todayKey);
  const reportCutoff = now.getTime() - 24 * 3600 * 1000;
  const noReportIds = new Set(tasks.filter((t) => t.assignee_id
    && (!t.last_report_at || new Date(t.last_report_at).getTime() < reportCutoff)).map((t) => t.assignee_id));
  const workload = new Map();
  for (const t of tasks) if (t.assignee_id) workload.set(t.assignee_id, (workload.get(t.assignee_id) || 0) + 1);

  const lines = ['Доброе утро. Сводка по задачам.',
    `Открытых: ${tasks.length} (в работе ${counts.in_progress}, ожидают ${counts.waiting}, блокеры ${counts.blocked}).`];
  if (blocked.length) {
    lines.push('Блокеры:');
    for (const t of blocked) lines.push(`- №${t.id} «${t.title}» — ${who(t.assignee_id)}`);
  }
  if (stale.length) {
    lines.push(`Без движения ${STALE_DAYS}+ дня:`);
    for (const t of stale) {
      const days = Math.floor((now.getTime() - new Date(t.updated_at).getTime()) / (24 * 3600 * 1000));
      lines.push(`- №${t.id} «${t.title}» — ${who(t.assignee_id)} (${days} дн.)`);
    }
  }
  if (overdue.length) {
    lines.push('Просроченные:');
    for (const t of overdue) lines.push(`- №${t.id} «${t.title}» — ${who(t.assignee_id)}`);
  }
  if (dueToday.length) {
    lines.push('Срок сегодня:');
    for (const t of dueToday) lines.push(`- №${t.id} «${t.title}» — ${who(t.assignee_id)}`);
  }
  if (noReportIds.size) lines.push(`Без свежего отчёта: ${[...noReportIds].map(who).join(', ')}.`);
  if (workload.size) lines.push(`Загрузка: ${[...workload].map(([id, count]) => `${who(id)} — ${count}`).join('; ')}.`);
  if (stockAlerts.length) {
    lines.push('Склад:');
    for (const s of stockAlerts.slice(0, 10)) {
      lines.push(`- ${s.name}: всего ${Number(s.qty)}, резерв ${Number(s.reserved_qty)}, доступно ${Number(s.available_qty)} ${s.unit}`);
    }
  }
  if (!blocked.length && !stale.length && !overdue.length) lines.push('Блокеров и зависших нет. Просрочек нет.');
  return lines.join('\n');
}

async function getMorningSummary() {
  const [employees, tasks, stockAlerts] = await Promise.all([
    listEmployees(), listOpenTasksBrief(), listStockAlerts(20),
  ]);
  return buildMorningSummary(tasks, employees, new Date(), stockAlerts);
}

async function runMorningSummary() {
  const targets = config.SCHEDULER_BOSS_WA.length ? config.SCHEDULER_BOSS_WA : config.BOSS_CONTACTS;
  if (!targets.length) {
    console.warn('[Scheduler] Утренняя сводка: нет получателей (BOSS_CONTACTS/SCHEDULER_BOSS_WA пусты)');
    return { sent: 0, total: 0 };
  }
  const text = await getMorningSummary();
  const quiet = await quietDigitsSet();
  let sent = 0;
  for (const digits of targets) {
    // Босс в тихом режиме — утреннюю сводку не шлём.
    if (quiet.has(String(digits).replace(/\D/g, ''))) continue;
    const ok = await notifier.deliver('whatsapp', digits, text);
    if (ok) sent += 1;
  }
  console.log(`[Scheduler] Утренняя сводка боссу: ${sent}/${targets.length} отправлено`);
  return { sent, total: targets.length };
}

// ── Вечер: ежедневная сводка по наблюдаемым группам ─────────────────────────
function buildGroupDailySummary(messages = [], dateStr = '', groupName = 'Наблюдаемая группа') {
  if (!messages.length) {
    return `Сводка по группе «${groupName}» за ${dateStr}:\nАктивности и сообщений за сегодня не зафиксировано.`;
  }
  const participants = [...new Set(messages.map((m) => m.who || m.actor_name).filter(Boolean))];
  const voices = messages.filter((m) => String(m.text || m.content || '').includes('[ГОЛОСОВОЕ'));
  const docs = messages.filter((m) => String(m.text || m.content || '').includes('[ИЗОБРАЖЕНИЕ'));
  const issues = messages.filter((m) => /(задержк|брак|ошибк|не успе|нет машин|пробк|отмен)/i.test(String(m.text || m.content || '')));

  const lines = [
    `Ежедневная сводка по группе «${groupName}» (${dateStr}):`,
    `- Всего сообщений: ${messages.length}`,
    `- Активные участники (${participants.length}): ${participants.join(', ')}`,
  ];

  if (voices.length) {
    lines.push(`\n🎙️ Голосовые сообщения (${voices.length}):`);
    for (const v of voices.slice(0, 5)) {
      const txt = String(v.text || v.content || '').replace(/\[ГОЛОСОВОЕ.*?\]\s*/, '').trim();
      lines.push(`- ${v.who || v.actor_name}: ${txt.slice(0, 200)}`);
    }
  }

  if (docs.length) {
    lines.push(`\n📄 Документы и накладные (${docs.length}):`);
    for (const d of docs.slice(0, 5)) {
      const txt = String(d.text || d.content || '').replace(/\[ИЗОБРАЖЕНИЕ.*?\]\s*/, '').trim();
      lines.push(`- ${d.who || d.actor_name}: ${txt.slice(0, 200)}`);
    }
  }

  if (issues.length) {
    lines.push(`\n⚠️ Внимание / Задержки (${issues.length}):`);
    for (const i of issues.slice(0, 5)) {
      lines.push(`- ${i.who || i.actor_name}: ${String(i.text || i.content || '').slice(0, 150)}`);
    }
  }

  return lines.join('\n');
}

async function runGroupDailySummary(now = new Date()) {
  const { getObservedGroupIds, getObservedGroupsInfo } = require('./groupObserver');
  const groupsInfo = getObservedGroupsInfo();
  const groupIds = getObservedGroupIds();
  if (!groupIds.length) return { sent: 0, total: 0 };

  const { archiveChatPage } = require('./mysql');
  const startOfDay = localNow(now);
  startOfDay.setUTCHours(0, 0, 0, 0);
  const dateStr = localDateKey(now);

  const targets = new Set();
  for (const d of config.GROUP_REPORT_REQUESTERS_WA) targets.add(d);
  for (const d of config.SCHEDULER_BOSS_WA) targets.add(d);
  for (const d of config.BOSS_CONTACTS) targets.add(d);

  const quiet = await quietDigitsSet();
  let totalSent = 0;

  const targetGroups = groupsInfo.length ? groupsInfo : groupIds.map((id) => ({ id, name: 'Наблюдаемая группа' }));

  for (const g of targetGroups) {
    const rows = await archiveChatPage({
      channel: 'whatsapp',
      chatId: g.id,
      fromUtc: startOfDay,
      toUtc: now,
      limit: 300,
    });
    if (!rows.length) continue;

    const text = buildGroupDailySummary(rows, dateStr, g.name || 'Наблюдаемая группа');

    for (const digits of targets) {
      if (!digits || quiet.has(String(digits).replace(/\D/g, ''))) continue;
      const ok = await notifier.deliver('whatsapp', digits, text);
      if (ok) totalSent += 1;
    }
  }

  console.log(`[Scheduler] Ежедневная сводка по наблюдаемым группам: ${totalSent}/${targets.size} отправлено`);
  return { sent: totalSent, total: targets.size };
}

// ── Управление (инструмент manage_scheduler) ───────────────────────────────
function getState() {
  return {
    enabled: state.enabled,
    morning_hour: state.morningHour,
    evening_hour: state.eveningHour,
    tz: `UTC+${config.SCHEDULER_TZ_OFFSET_MIN / 60}`,
    last_morning: lastRun.morning || null,
    last_evening: lastRun.evening || null,
    last_group_summary: lastRun.group_summary || null,
    note: 'вс — выходной',
  };
}

async function setEnabled(on) {
  state.enabled = Boolean(on);
  await setSetting('scheduler.enabled', state.enabled ? '1' : '0');
  console.log(`[Scheduler] ${state.enabled ? 'Включен' : 'Выключен'} (через manage_scheduler)`);
  return getState();
}

async function setHours({ morning, evening }) {
  const valid = (h) => Number.isInteger(h) && h >= 0 && h <= 23;
  if (morning !== undefined) {
    if (!valid(morning)) throw new Error(`morning_hour должен быть 0–23, получено: ${morning}`);
    state.morningHour = morning;
    await setSetting('scheduler.morning_hour', String(morning));
  }
  if (evening !== undefined) {
    if (!valid(evening)) throw new Error(`evening_hour должен быть 0–23, получено: ${evening}`);
    state.eveningHour = evening;
    await setSetting('scheduler.evening_hour', String(evening));
  }
  console.log(`[Scheduler] Часы обновлены: утро ${state.morningHour}:00, вечер ${state.eveningHour}:00`);
  return getState();
}

// Переопределения из БД (то, что ИИ настроил ранее) поверх env-дефолтов +
// восстановление отметок «уже слали сегодня» (чтобы рестарт не дублировал).
async function loadOverrides() {
  const s = await getSettings('scheduler.');
  if (s['scheduler.enabled'] !== undefined) state.enabled = s['scheduler.enabled'] === '1';
  const mh = parseInt(s['scheduler.morning_hour'], 10);
  const eh = parseInt(s['scheduler.evening_hour'], 10);
  if (Number.isInteger(mh) && mh >= 0 && mh <= 23) state.morningHour = mh;
  if (Number.isInteger(eh) && eh >= 0 && eh <= 23) state.eveningHour = eh;
  if (s['scheduler.last_morning']) lastRun.morning = s['scheduler.last_morning'];
  if (s['scheduler.last_evening']) lastRun.evening = s['scheduler.last_evening'];
  if (s['scheduler.last_group_summary']) lastRun.group_summary = s['scheduler.last_group_summary'];
}

// ── Цикл ───────────────────────────────────────────────────────────────────
async function tick(now = new Date()) {
  try {
    if (!state.enabled) return;
    if (shouldFire('morning', state.morningHour, now)) {
      const r = await runMorningSummary();
      // Отмечаем выполненным только при реальной отправке (или когда слать некому/нечего).
      if (r.sent > 0 || r.total === 0) await markDone('morning', now);
    }
    if (shouldFire('evening', state.eveningHour, now)) {
      const r = await runEveningReminders();
      if (r.sent > 0 || r.total === 0) await markDone('evening', now);
      const rg = await runGroupDailySummary(now);
      if (rg.sent > 0 || rg.total === 0) await markDone('group_summary', now);
    }
  } catch (err) {
    console.error('[Scheduler] tick:', err.message);
    require('./developerFeedback').reportDeveloperError(`Планировщик отчётов: ${err.message}`, { includeHistory: false }).catch(() => {});
  }
}

let timer = null;
async function start() {
  if (timer) return;
  try {
    await loadOverrides();
  } catch (err) {
    console.error('[Scheduler] loadOverrides:', err.message);
  }
  // Таймер крутится всегда (даже при enabled=false) — ИИ может включить на лету.
  timer = setInterval(tick, 60 * 1000);
  if (timer.unref) timer.unref();
  const tz = config.SCHEDULER_TZ_OFFSET_MIN / 60;
  console.log(`[Scheduler] ${state.enabled ? 'Включен' : 'Выключен (включается через manage_scheduler)'}: `
    + `сводка боссу в ${state.morningHour}:00, сбор статусов в ${state.eveningHour}:00 (UTC+${tz}), вс — выходной`);
}

module.exports = {
  start,
  getState, setEnabled, setHours,
  getMorningSummary, runMorningSummary, runEveningReminders, runGroupDailySummary, buildGroupDailySummary,
  // для тестов
  _internals: { shouldFire, buildEveningReminders, buildMorningSummary, buildGroupDailySummary, firstName, state },
};

'use strict';
// Планировщик отчётов — ежедневные ритуалы компании (см. orchestrator_learning_patterns.md):
//  - ВЕЧЕРОМ (EVENING_REPORT_HOUR) каждому сотруднику с открытыми задачами уходит
//    персональное напоминание отписаться по задачам (ответ обработает обычный
//    пайплайн в режиме EMPLOYEE CONTEXT → update_task).
//  - УТРОМ (MORNING_SUMMARY_HOUR) боссу уходит сводка: нагрузка, блокеры,
//    задачи без движения 2+ дня.
// Воскресенье — выходной. Время локальное (SCHEDULER_TZ_OFFSET_MIN, Казахстан UTC+5).
// Дедупликация — по дате последнего запуска каждой джобы (в памяти процесса).
const config = require('../config');
const { listEmployees, listOpenTasksBrief } = require('./mysql');
const notifier = require('./notifier');

const STATUS_RU = {
  new: 'не взята',
  dispatched: 'ожидает',
  in_progress: 'в работе',
  blocked: 'блокер',
};

const STALE_DAYS = 2;       // «без движения» = updated_at старше этого
const MAX_LINES = 10;       // не раздувать сообщение сотруднику

// «Юрин Владимир» → «Владимир»; «Али» → «Али» (в реестре формат «Фамилия Имя»).
function firstName(name) {
  const parts = String(name || '').trim().split(/\s+/);
  return parts.length > 1 ? parts[1] : (parts[0] || '');
}

function localNow(now, tzOffsetMin) {
  const off = (tzOffsetMin === undefined) ? config.SCHEDULER_TZ_OFFSET_MIN : tzOffsetMin;
  return new Date(now.getTime() + off * 60000);
}

// Состояние «когда джоба стреляла в последний раз» (ключ = дата YYYY-MM-DD).
const lastRun = { morning: '', evening: '' };

// true ровно один раз в день, в заданный локальный час, кроме воскресенья.
function shouldFire(job, hour, now = new Date(), state = lastRun) {
  const loc = localNow(now);
  if (loc.getUTCDay() === 0) return false; // воскресенье — выходной
  if (loc.getUTCHours() !== hour) return false;
  const dateKey = loc.toISOString().slice(0, 10);
  if (state[job] === dateKey) return false;
  state[job] = dateKey;
  return true;
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
      text: `${firstName(e.name)}, конец дня — отпишись по задачам:\n`
        + `${lines.join('\n')}${more}\n`
        + 'Что сделано, что в работе, что блокирует?',
    });
  }
  return out;
}

async function runEveningReminders() {
  const [employees, tasks] = await Promise.all([listEmployees(), listOpenTasksBrief()]);
  const reminders = buildEveningReminders(employees, tasks);
  let sent = 0;
  for (const r of reminders) {
    const ok = await notifier.deliver(r.employee.channel || 'whatsapp', r.employee.contact, r.text);
    if (ok) sent += 1;
  }
  console.log(`[Scheduler] Вечерний сбор статусов: ${sent}/${reminders.length} отправлено`);
  return sent;
}

// ── Утро: сводка боссу ─────────────────────────────────────────────────────
function buildMorningSummary(tasks, employees, now = new Date()) {
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
  if (!blocked.length && !stale.length) lines.push('Блокеров и зависших нет.');
  return lines.join('\n');
}

async function runMorningSummary() {
  const targets = config.SCHEDULER_BOSS_WA.length ? config.SCHEDULER_BOSS_WA : config.BOSS_CONTACTS;
  if (!targets.length) {
    console.warn('[Scheduler] Утренняя сводка: нет получателей (BOSS_CONTACTS/SCHEDULER_BOSS_WA пусты)');
    return 0;
  }
  const [employees, tasks] = await Promise.all([listEmployees(), listOpenTasksBrief()]);
  const text = buildMorningSummary(tasks, employees);
  let sent = 0;
  for (const digits of targets) {
    const ok = await notifier.deliver('whatsapp', digits, text);
    if (ok) sent += 1;
  }
  console.log(`[Scheduler] Утренняя сводка боссу: ${sent}/${targets.length} отправлено`);
  return sent;
}

// ── Цикл ───────────────────────────────────────────────────────────────────
async function tick(now = new Date()) {
  try {
    if (shouldFire('morning', config.MORNING_SUMMARY_HOUR, now)) await runMorningSummary();
    if (shouldFire('evening', config.EVENING_REPORT_HOUR, now)) await runEveningReminders();
  } catch (err) {
    console.error('[Scheduler] tick:', err.message);
  }
}

let timer = null;
function start() {
  if (!config.SCHEDULER_ENABLED) {
    console.log('[Scheduler] Выключен (REPORT_SCHEDULER=0)');
    return;
  }
  if (timer) return;
  timer = setInterval(tick, 60 * 1000);
  if (timer.unref) timer.unref();
  const tz = config.SCHEDULER_TZ_OFFSET_MIN / 60;
  console.log(`[Scheduler] Включен: сводка боссу в ${config.MORNING_SUMMARY_HOUR}:00, `
    + `сбор статусов в ${config.EVENING_REPORT_HOUR}:00 (UTC+${tz}), вс — выходной`);
}

module.exports = {
  start,
  // для тестов
  _internals: { shouldFire, buildEveningReminders, buildMorningSummary, firstName },
};

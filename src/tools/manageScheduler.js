'use strict';
// Управление планировщиком отчётов из агентного цикла: ИИ — администратор своих
// процессов. Статус, вкл/выкл, смена часов, ручной запуск рассылок.
// Настройки сохраняются в orch_settings и переживают рестарт.
const scheduler = require('../services/reportScheduler');

const definition = {
  type: 'function',
  function: {
    name: 'manage_scheduler',
    description:
      'Управление планировщиком отчётов (доступно всем; изменения не-боссом автоматически уведомляют руководителя). Планировщик сам шлёт утром сводку '
      + 'боссу, вечером — напоминания сотрудникам отписаться по открытым задачам (вс — выходной). '
      + 'Действия: status — текущее состояние; enable/disable — включить/выключить; '
      + 'set_times — поменять часы (morning_hour и/или evening_hour, 0–23, локальное время); '
      + 'run_morning_now — отправить сводку боссу прямо сейчас; '
      + 'get_summary — вернуть актуальную сводку в текущий чат без отдельной рассылки; '
      + 'run_evening_now — разослать сотрудникам напоминания прямо сейчас. '
      + 'Изменения сохраняются и переживают перезапуск.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['status', 'enable', 'disable', 'set_times', 'get_summary', 'run_morning_now', 'run_evening_now'],
          description: 'Что сделать с планировщиком.',
        },
        morning_hour: { type: 'integer', description: 'Час утренней сводки боссу (0–23), для set_times.' },
        evening_hour: { type: 'integer', description: 'Час вечернего сбора статусов (0–23), для set_times.' },
      },
      required: ['action'],
    },
  },
};

// Доступен всем (иерархии нет); мутации не-боссом автоматически уведомляют
// руководителя — см. NOTIFY_BOSS_MUTATIONS в tools/index.js.
async function handler(args, context = {}) {
  try {
    switch (args.action) {
      case 'status':
        return { success: true, scheduler: scheduler.getState() };
      case 'enable':
        return { success: true, scheduler: await scheduler.setEnabled(true) };
      case 'disable':
        return { success: true, scheduler: await scheduler.setEnabled(false) };
      case 'set_times': {
        if (args.morning_hour === undefined && args.evening_hour === undefined) {
          return { success: false, message: 'Укажи morning_hour и/или evening_hour (0–23).' };
        }
        const st = await scheduler.setHours({ morning: args.morning_hour, evening: args.evening_hour });
        return { success: true, scheduler: st };
      }
      case 'run_morning_now': {
        const r = await scheduler.runMorningSummary();
        return { success: r.sent > 0 || r.total === 0, ...r, note: `сводка отправлена ${r.sent}/${r.total}` };
      }
      case 'get_summary':
        return { success: true, summary: await scheduler.getMorningSummary() };
      case 'run_evening_now': {
        const r = await scheduler.runEveningReminders();
        return { success: true, ...r, note: `напоминаний отправлено ${r.sent}/${r.total}` };
      }
      default:
        return { success: false, message: `Неизвестное действие: ${args.action}` };
    }
  } catch (err) {
    return { success: false, message: err.message };
  }
}

module.exports = { definition, handler };

'use strict';
const { addEmployee, updateEmployee, deactivateEmployee, findEmployees, findEmployeeByContact } = require('../services/mysql');
const { normalizePhone } = require('../services/employeeImport');

const definition = {
  type: 'function',
  function: {
    name: 'manage_employees',
    description:
      'Управление реестром сотрудников (ТОЛЬКО для босса): добавить новых, изменить или удалить '
      + '(деактивировать). Используй, когда босс присылает новый список/изменения по штату. Телефон '
      + 'указывай в любом формате — нормализуется автоматически (WhatsApp). Для массового добавления '
      + 'передай несколько в employees[].',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['add', 'update', 'remove'], description: 'Что сделать.' },
        employees: {
          type: 'array',
          description: 'Для action=add: список новых сотрудников.',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              roles: { type: 'string', description: 'Должность/роль.' },
              skills: { type: 'string', description: 'Обязанности/навыки.' },
              phone: { type: 'string', description: 'Телефон (WhatsApp).' },
            },
            required: ['name'],
          },
        },
        query: { type: 'string', description: 'Для update/remove: id, имя или роль сотрудника.' },
        fields: {
          type: 'object',
          description: 'Для action=update: какие поля изменить.',
          properties: {
            name: { type: 'string' },
            roles: { type: 'string' },
            skills: { type: 'string' },
            phone: { type: 'string' },
          },
        },
      },
      required: ['action'],
    },
  },
};

async function handler(args) {
  if (args.action === 'add') {
    const list = Array.isArray(args.employees) ? args.employees : [];
    if (!list.length) return { success: false, message: 'Пустой список employees.' };
    const added = [];
    const skipped = [];
    for (const e of list) {
      if (!e.name) continue;
      const contact = normalizePhone(e.phone);
      // Дубликат номера — не молчим: говорим, у кого он уже есть.
      if (contact) {
        const dup = await findEmployeeByContact('whatsapp', contact);
        if (dup) { skipped.push({ name: e.name, contact, reason: `номер уже у «${dup.name}» (#${dup.id})` }); continue; }
      }
      const id = await addEmployee({
        name: e.name, roles: e.roles || 'сотрудник', skills: e.skills || null,
        channel: contact ? 'whatsapp' : null, contact,
      });
      if (id) added.push({ id, name: e.name, contact: contact || null });
      else skipped.push({ name: e.name, contact: contact || null, reason: 'не удалось сохранить (возможно, дубль номера)' });
    }
    const out = { success: added.length > 0 || skipped.length === 0, action: 'add', added_count: added.length, added };
    if (skipped.length) {
      out.skipped = skipped;
      if (!added.length) out.message = 'Никто не добавлен: ' + skipped.map((s) => `${s.name} — ${s.reason}`).join('; ');
    }
    return out;
  }

  if (args.action === 'update' || args.action === 'remove') {
    const matches = await findEmployees(args.query);
    if (!matches.length) return { success: false, message: `Сотрудник не найден: «${args.query}».` };
    if (matches.length > 1) {
      return {
        success: false,
        ambiguous: matches.map((m) => ({ id: m.id, name: m.name, roles: m.roles })),
        message: 'Найдено несколько — уточни id.',
      };
    }
    const emp = matches[0];
    if (args.action === 'remove') {
      await deactivateEmployee(emp.id);
      return { success: true, action: 'remove', id: emp.id, name: emp.name };
    }
    const f = args.fields || {};
    const fields = {};
    if (f.name !== undefined) fields.name = f.name;
    if (f.roles !== undefined) fields.roles = f.roles;
    if (f.skills !== undefined) fields.skills = f.skills;
    if (f.phone !== undefined) {
      const c = normalizePhone(f.phone);
      if (c) {
        const dup = await findEmployeeByContact('whatsapp', c);
        if (dup && dup.id !== emp.id) {
          return { success: false, message: `Этот номер уже у «${dup.name}» (#${dup.id}). Сначала освободи его или укажи другой.` };
        }
      }
      fields.contact = c;
      fields.channel = c ? 'whatsapp' : null;
    }
    await updateEmployee(emp.id, fields);
    return { success: true, action: 'update', id: emp.id, name: emp.name, updated: Object.keys(fields) };
  }

  return { success: false, message: `Неизвестное действие: ${args.action}` };
}

module.exports = { definition, handler };

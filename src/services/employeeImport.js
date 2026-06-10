'use strict';
const fs = require('fs');
const path = require('path');

// Импорт реального штата из Excel «Структура Неодрэйн.xlsx».
// Колонки: ФИО | Должность | Роль | Телефон | битрикс | Примечания
//   ФИО       → name
//   Должность → roles   (короткая роль/должность для подбора)
//   Роль      → skills  (описание обязанностей)
//   Телефон   → contact (WhatsApp, нормализованный в международный формат)

const DEFAULT_NAME = process.env.EMPLOYEE_FILE || 'Структура Неодрэйн.xlsx';

function candidatePaths() {
  return [
    path.isAbsolute(DEFAULT_NAME) ? DEFAULT_NAME : path.join(process.cwd(), DEFAULT_NAME),
    path.join(__dirname, '..', '..', DEFAULT_NAME), // корень проекта
  ];
}

function resolveFile() {
  for (const p of candidatePaths()) {
    try { if (fs.existsSync(p)) return p; } catch (_) { /* ignore */ }
  }
  return null;
}

// 87075301259 → 77075301259 (KZ: ведущая 8 → 7). Для WhatsApp нужны цифры
// в международном формате (диспатч добавит @s.whatsapp.net).
function normalizePhone(raw) {
  let d = String(raw == null ? '' : raw).replace(/\D/g, '');
  if (!d) return null;
  if (d.length === 11 && d.startsWith('8')) d = '7' + d.slice(1);
  else if (d.length === 10) d = '7' + d;
  return d.length >= 10 ? d : null;
}

// Достаёт значение по любому из вариантов заголовка (без учёта регистра/пробелов).
function field(normRow, candidates) {
  for (const c of candidates) {
    const v = normRow[c.toLowerCase().trim()];
    if (v !== undefined && String(v).trim() !== '') return String(v).trim();
  }
  return '';
}

// → [{ name, roles, skills, channel, contact }]
function loadEmployeesFromExcel() {
  const file = resolveFile();
  if (!file) {
    console.log('[EmployeeImport] Файл штата не найден — пропускаю импорт');
    return [];
  }
  let rows;
  try {
    const XLSX = require('xlsx');
    const wb = XLSX.readFile(file);
    const ws = wb.Sheets[wb.SheetNames[0]];
    rows = XLSX.utils.sheet_to_json(ws, { defval: '' });
  } catch (err) {
    console.error('[EmployeeImport] Ошибка чтения Excel:', err.message);
    return [];
  }

  const out = [];
  for (const r of rows) {
    const norm = {};
    for (const k of Object.keys(r)) norm[k.toLowerCase().trim()] = r[k];

    const name = field(norm, ['фио', 'имя', 'сотрудник', 'name']);
    if (!name) continue;
    const position = field(norm, ['должность', 'position']) || 'сотрудник';
    const skills = field(norm, ['роль', 'обязанности', 'описание', 'skills']);
    const contact = normalizePhone(field(norm, ['телефон', 'whatsapp', 'контакт', 'phone', 'тел']));

    out.push({
      name,
      roles: position,
      skills,
      channel: contact ? 'whatsapp' : null,
      contact,
    });
  }
  console.log(`[EmployeeImport] Прочитано из «${path.basename(file)}»: ${out.length} сотрудников`);
  return out;
}

module.exports = { loadEmployeesFromExcel, normalizePhone };

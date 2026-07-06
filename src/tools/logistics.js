'use strict';

// Логистика/паллетировка: расчёт доставки по ОТДЕЛЬНОЙ справочной базе (вес, объём,
// кол-во на паллете) + подбор машины. Данные НЕ связаны с прайсами. Импорт —
// scripts/importLogistics.js; парсер — services/logistics.js.

const { logisticsGetByArticle, logisticsSearch, listTrucks } = require('../services/mysql');
const { handleToolDbError } = require('../utils/toolError');
const { PALLET_TARE_KG } = require('../config');

const SOURCE_LABELS = {
  ves_plastik: 'Вес паллет пластик',
  raspal_tde: 'Распаллетка · ТДЕ (пластик Gidrolica)',
  raspal_beton: 'Распаллетка · Бетон БГ',
  raspal_yartsevo: 'Распаллетка · Ярцево (бетон)',
  palletirovka: 'Паллетировка',
};

const definition = {
  type: 'function',
  function: {
    name: 'logistics',
    description:
      'Логистика/паллетировка: отдельная справочная база (вес 1 ед., объём, кол-во на паллете) по пластику Norma/Gidrolica и бетону BGF/BGU/GBU + справочник грузовых машин. НЕ связана с прайсами/ценами. '
      + 'Действия: lookup — данные позиции по артикулу или названию; calculate — по списку позиций и количеств посчитать паллеты, общий вес (товара и с паллетами), объём и подобрать машину; trucks — справочник машин. '
      + 'Позицию адресуй точным артикулом (article) или поисковым запросом (query); при нескольких совпадениях вернётся reason=ambiguous с кандидатами — не угадывай.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['lookup', 'calculate', 'trucks'] },
        article: { type: 'string', description: 'Точный артикул (№ по каталогу) для lookup.' },
        query: { type: 'string', description: 'Название/DN/класс для поиска позиции (lookup, если артикул неизвестен).' },
        items: {
          type: 'array',
          description: 'calculate: строки заказа — артикул или запрос + количество.',
          items: {
            type: 'object',
            properties: {
              article: { type: 'string', description: 'Точный артикул позиции.' },
              query: { type: 'string', description: 'Если артикул неизвестен — название/DN для поиска.' },
              qty: { type: 'number', description: 'Количество единиц.' },
            },
            required: ['qty'],
          },
        },
      },
      required: ['action'],
    },
  },
};

function num(v) { return v == null ? null : Number(v); }

function publicItem(row) {
  return {
    source: row.source,
    source_label: SOURCE_LABELS[row.source] || row.source,
    article: row.article,
    name: row.name,
    series: row.series || null,
    load_class: row.load_class || null,
    dn: row.dn || null,
    length_mm: num(row.length_mm),
    width_mm: num(row.width_mm),
    height_mm: num(row.height_mm),
    volume_m3: num(row.volume_m3),
    weight_kg: num(row.weight_kg),
    qty_per_pallet: row.qty_per_pallet == null ? null : Number(row.qty_per_pallet),
    pallet_weight_kg: num(row.pallet_weight_kg),
    note: row.note || null,
  };
}

function publicTruck(t) {
  return {
    name: t.name,
    payload_t: num(t.payload_t),
    volume_m3: num(t.volume_m3),
    inner_length_m: num(t.inner_length_m),
    inner_width_m: num(t.inner_width_m),
    inner_height_m: num(t.inner_height_m),
    pallet_places: t.pallet_places == null ? null : Number(t.pallet_places),
  };
}

// Разрешить позицию: точный артикул → все источники (первый — самый полный);
// иначе поиск. Один артикул часто есть в нескольких файлах — это НЕ ambiguous,
// берём приоритетный источник и перечисляем остальные в other_sources.
async function resolveItem({ article, query }) {
  const art = String(article || '').trim();
  if (art) {
    const rows = await logisticsGetByArticle(art);
    if (rows.length) {
      return { item: rows[0], others: rows.slice(1) };
    }
  }
  const raw = String(query || article || '').trim();
  if (!raw) return { reason: 'invalid_query', candidates: [] };
  const matches = await logisticsSearch(raw, 6);
  // Схлопываем один и тот же артикул из разных файлов в одного кандидата.
  const byArticle = new Map();
  for (const m of matches) { if (!byArticle.has(m.article_norm)) byArticle.set(m.article_norm, m); }
  const unique = [...byArticle.values()];
  if (unique.length === 1) return { item: unique[0], others: [] };
  return { reason: unique.length ? 'ambiguous' : 'not_found', candidates: unique.map(publicItem) };
}

// Подбор машины: наименьшая, куда влезает заказ по весу (с паллетами), паллето-местам
// и объёму. Если ни одна не вмещает — сколько нужно самой большой.
function recommendTruck(trucks, { weightWithPalletsKg, pallets, volumeM3 }) {
  const fitting = trucks.filter((t) => {
    const okWeight = t.payload_t == null || t.payload_t * 1000 >= weightWithPalletsKg;
    const okPallets = t.pallet_places == null || pallets == null || t.pallet_places >= pallets;
    const okVolume = t.volume_m3 == null || t.volume_m3 >= volumeM3;
    return okWeight && okPallets && okVolume;
  });
  if (fitting.length) {
    // trucks уже отсортированы по payload_t ASC — первая подходящая и есть наименьшая.
    return { truck: publicTruck(fitting[0]), trucks_needed: 1 };
  }
  // Не влезает в одну — считаем по самой вместительной (последней после сортировки).
  const biggest = trucks[trucks.length - 1];
  if (!biggest) return { truck: null, trucks_needed: null };
  const need = Math.max(
    biggest.payload_t ? Math.ceil(weightWithPalletsKg / (biggest.payload_t * 1000)) : 1,
    biggest.pallet_places && pallets ? Math.ceil(pallets / biggest.pallet_places) : 1,
    biggest.volume_m3 ? Math.ceil(volumeM3 / biggest.volume_m3) : 1,
  );
  return { truck: publicTruck(biggest), trucks_needed: need, exceeds_single: true };
}

async function handler(args) {
  try {
    if (args.action === 'trucks') {
      const rows = await listTrucks();
      return { success: true, count: rows.length, trucks: rows.map(publicTruck) };
    }

    if (args.action === 'lookup') {
      const resolved = await resolveItem({ article: args.article, query: args.query });
      if (!resolved.item) {
        return { success: false, reason: resolved.reason, candidates: resolved.candidates || [] };
      }
      return {
        success: true,
        item: publicItem(resolved.item),
        other_sources: (resolved.others || []).map(publicItem),
        note: 'Логистическая справка (вес/объём/кол-во на паллете). Данные НЕ связаны с прайсом/ценой.',
      };
    }

    if (args.action !== 'calculate') return { success: false, reason: 'invalid_action' };

    const input = Array.isArray(args.items) ? args.items : [];
    if (!input.length) return { success: false, reason: 'empty_items', message: 'Добавь хотя бы одну позицию с количеством.' };

    const lines = [];
    for (const line of input) {
      const qty = Number(line.qty);
      if (!Number.isFinite(qty) || qty <= 0) {
        return { success: false, reason: 'invalid_qty', query: line.query || line.article, message: 'Количество должно быть больше нуля.' };
      }
      const resolved = await resolveItem({ article: line.article, query: line.query });
      if (!resolved.item) {
        return { success: false, reason: resolved.reason, query: line.query || line.article, candidates: resolved.candidates || [] };
      }
      const item = publicItem(resolved.item);
      const pallets = item.qty_per_pallet ? Math.ceil(qty / item.qty_per_pallet) : null;
      const weight = item.weight_kg == null ? null : Number((item.weight_kg * qty).toFixed(3));
      const volume = item.volume_m3 == null ? null : Number((item.volume_m3 * qty).toFixed(5));
      lines.push({
        ...item,
        qty,
        pallets,
        pallets_note: pallets == null ? 'кол-во на паллете не задано — считается по факту заказа' : null,
        line_weight_kg: weight,
        line_volume_m3: volume,
      });
    }

    const totalPallets = lines.reduce((s, l) => s + (l.pallets || 0), 0);
    const anyPalletUnknown = lines.some((l) => l.pallets == null);
    const totalWeight = Number(lines.reduce((s, l) => s + (l.line_weight_kg || 0), 0).toFixed(3));
    const totalVolume = Number(lines.reduce((s, l) => s + (l.line_volume_m3 || 0), 0).toFixed(5));
    const weightWithPallets = Number((totalWeight + PALLET_TARE_KG * totalPallets).toFixed(3));

    const trucks = (await listTrucks()).map(publicTruck);
    const recommendation = trucks.length
      ? recommendTruck(trucks, { weightWithPalletsKg: weightWithPallets, pallets: anyPalletUnknown ? null : totalPallets, volumeM3: totalVolume })
      : { truck: null, trucks_needed: null };

    return {
      success: true,
      lines,
      totals: {
        goods_weight_kg: totalWeight,
        pallets: totalPallets,
        pallet_tare_kg: PALLET_TARE_KG,
        weight_with_pallets_kg: weightWithPallets,
        volume_m3: totalVolume,
        pallets_incomplete: anyPalletUnknown,
      },
      truck_recommendation: recommendation,
      note: 'Расчёт по логистической базе (отдельная от прайса). Вес с паллетами = вес товара + '
        + `${PALLET_TARE_KG} кг × кол-во паллет. Подбор машины — по весу с паллетами, паллето-местам и объёму.`
        + (anyPalletUnknown ? ' ВНИМАНИЕ: у части позиций не задано кол-во на паллете — итог паллет неполный, скажи об этом человеку.' : ''),
    };
  } catch (err) {
    return handleToolDbError(err);
  }
}

module.exports = { definition, handler };

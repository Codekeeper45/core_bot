'use strict';
// Официальный курс валют к тенге (KZT) от Нацбанка РК — надёжный источник вместо свободного
// web_search (1 запрос вместо 15). Доступен всем. Возвращает ОФИЦИАЛЬНЫЙ курс НБ РК (не
// «покупка/продажа банка» — такого надёжного бесплатного источника по конкретному банку нет).
const NBK_URL = 'https://nationalbank.kz/rss/rates_all.xml';

const definition = {
  type: 'function',
  function: {
    name: 'get_exchange_rate',
    description:
      'Официальный курс валюты к тенге (KZT) от Нацбанка РК на текущую дату. Используй для ЛЮБЫХ '
      + 'вопросов про курс/обменный курс (рубль, доллар, евро и т.д.) — НЕ web_search. Это '
      + 'официальный курс НБ РК (не «покупка/продажа» конкретного банка). Указывай код валюты '
      + '(RUB, USD, EUR, CNY…), по умолчанию RUB.',
    parameters: {
      type: 'object',
      properties: {
        code: { type: 'string', description: 'Код валюты ISO (RUB, USD, EUR, CNY…). По умолчанию RUB.' },
      },
      required: [],
    },
  },
};

// Чистый парсер XML НБ РК: вернуть { code, rate, per, date } для нужной валюты или null.
function parseNbkRates(xml, code) {
  const want = String(code || 'RUB').toUpperCase();
  const items = String(xml || '').match(/<item>[\s\S]*?<\/item>/gi) || [];
  for (const it of items) {
    const title = (it.match(/<title>\s*([^<]+?)\s*<\/title>/i) || [])[1];
    if (!title || title.toUpperCase() !== want) continue;
    const desc = (it.match(/<description>\s*([^<]+?)\s*<\/description>/i) || [])[1];
    const quant = Number((it.match(/<quant>\s*([^<]+?)\s*<\/quant>/i) || [])[1] || '1') || 1;
    const date = (it.match(/<pubDate>\s*([^<]+?)\s*<\/pubDate>/i) || [])[1] || null;
    const raw = Number(desc);
    if (!isFinite(raw)) return null;
    return { code: want, rate: Math.round((raw / quant) * 10000) / 10000, per: quant, date };
  }
  return null;
}

async function handler(args = {}) {
  const code = String(args.code || 'RUB').toUpperCase();
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15000);
    let xml;
    try {
      const res = await fetch(NBK_URL, { signal: ctrl.signal });
      if (!res.ok) return { success: false, message: `НБ РК ответил ${res.status}` };
      xml = await res.text();
    } finally { clearTimeout(timer); }

    const r = parseNbkRates(xml, code);
    if (!r) return { success: false, message: `Валюта «${code}» не найдена в курсах НБ РК.` };
    return {
      success: true,
      code: r.code,
      rate_kzt: r.rate,
      date: r.date,
      source: 'Нацбанк РК (nationalbank.kz)',
      note: `Официальный курс НБ РК: 1 ${r.code} = ${r.rate} ₸ на ${r.date}. Это официальный курс (не покупка/продажа банка).`,
    };
  } catch (err) {
    return { success: false, message: `Не удалось получить курс: ${err.message}` };
  }
}

module.exports = { definition, handler, parseNbkRates, _internals: { parseNbkRates } };

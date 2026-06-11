'use strict';
// Веб-поиск через Brave Search API. Лёгкий кэш в памяти процесса (TTL 10 мин) экономит квоту.
const config = require('../config');

const CACHE = new Map(); // query → { at, results }
const TTL_MS = 10 * 60 * 1000;

function fromCache(key) {
  const hit = CACHE.get(key);
  if (hit && (Date.now() - hit.at) < TTL_MS) return hit.results;
  if (hit) CACHE.delete(key);
  return null;
}

// Возвращает { ok, results:[{title,url,snippet}] } или { ok:false, error }.
async function search(query, count = 5) {
  const q = String(query || '').trim();
  if (!q) return { ok: false, error: 'Пустой запрос.' };
  if (!config.BRAVE_API_KEY) return { ok: false, error: 'Веб-поиск не настроен (нет BRAVE_API_KEY).' };

  const n = Math.min(Math.max(Number(count) || 5, 1), 10);
  const key = `${n}:${q.toLowerCase()}`;
  const cached = fromCache(key);
  if (cached) return { ok: true, results: cached, cached: true };

  try {
    const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(q)}&count=${n}`;
    const res = await fetch(url, {
      headers: { Accept: 'application/json', 'X-Subscription-Token': config.BRAVE_API_KEY },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return { ok: false, error: `Brave API: ${res.status}` };
    const data = await res.json();
    const results = ((data.web && data.web.results) || []).slice(0, n).map((r) => ({
      title: r.title,
      url: r.url,
      snippet: r.description || '',
    }));
    CACHE.set(key, { at: Date.now(), results });
    return { ok: true, results };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

module.exports = { search, _cache: CACHE };

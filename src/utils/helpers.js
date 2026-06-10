'use strict';

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const normalizePhone = (v) => String(v || '').replace(/\D+/g, '');

// A "real", callable phone = 10–15 digits after stripping non-digits. Telegram
// passes a @username / numeric user-id as `phone`, which is NOT callable — this
// filters such junk out so it never lands in a CRM contact. Returns digits or ''.
const realPhone = (v) => {
  const d = normalizePhone(v);
  return d.length >= 10 && d.length <= 15 ? d : '';
};

// First callable phone among candidates (e.g. the deliberately-collected session
// phone, then the channel-context phone). Returns '' if none qualify.
const pickRealPhone = (...candidates) => {
  for (const c of candidates) { const d = realPhone(c); if (d) return d; }
  return '';
};

const getTodayDate = (timezone = 'Asia/Qyzylorda') => {
  return new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(new Date());
};

module.exports = { sleep, normalizePhone, realPhone, pickRealPhone, getTodayDate };

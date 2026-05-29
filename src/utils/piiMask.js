'use strict';

/**
 * PII Masking Utility
 * 
 * Masks personally identifiable information (PII) in logs:
 * - Phone numbers: +7 777 123 4567 → +7 777 *** **67
 * - Names: Иван Иванов → И*** И***
 * - BIN/IIN: 123456789012 → 1234******12
 * - Email: user@example.com → u***@example.com
 */

/**
 * Mask a phone number: keep country code and last 2 digits.
 * +7 777 123 4567 → +7 777 *** **67
 * 77771234567 → 7777******67
 */
function maskPhone(phone) {
  if (!phone || typeof phone !== 'string') return phone;
  const digits = phone.replace(/\D/g, '');
  if (digits.length < 4) return '***';
  const last2 = digits.slice(-2);
  const first3 = digits.slice(0, 3);
  return `${first3}${'*'.repeat(digits.length - 5)}${last2}`;
}

/**
 * Mask a name: keep first letter, replace rest with *.
 * Иван Иванов → И*** И***
 * Али → А***
 */
function maskName(name) {
  if (!name || typeof name !== 'string') return name;
  return name
    .split(/\s+/)
    .map(part => part.length > 0 ? part[0] + '*'.repeat(Math.max(part.length - 1, 2)) : part)
    .join(' ');
}

/**
 * Mask a BIN/IIN (12-digit business identifier).
 * 123456789012 → 1234******12
 */
function maskBin(bin) {
  if (!bin || typeof bin !== 'string') return bin;
  const cleaned = bin.replace(/\D/g, '');
  if (cleaned.length < 4) return '***';
  const first4 = cleaned.slice(0, 4);
  const last2 = cleaned.slice(-2);
  return `${first4}${'*'.repeat(cleaned.length - 6)}${last2}`;
}

/**
 * Mask an email address.
 * user@example.com → u***@example.com
 * long.email@domain.kz → l***@domain.kz
 */
function maskEmail(email) {
  if (!email || typeof email !== 'string') return email;
  const atIdx = email.indexOf('@');
  if (atIdx < 1) return '***@***';
  const local = email.slice(0, atIdx);
  const domain = email.slice(atIdx);
  return local[0] + '***' + domain;
}

/**
 * Mask PII in an object (recursively).
 * Masks known PII fields: phone, client_name, email, business_name_bin.
 * Returns a new object, does not mutate the original.
 */
function maskPiiInObject(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(maskPiiInObject);

  const PII_FIELDS = {
    phone: maskPhone,
    client_name: maskName,
    clientName: maskName,
    name: maskName,
    email: maskEmail,
    business_name_bin: maskBin,
    businessNameBin: maskBin,
  };

  const result = {};
  for (const [key, value] of Object.entries(obj)) {
    if (PII_FIELDS[key]) {
      result[key] = PII_FIELDS[key](value);
    } else if (typeof value === 'object' && value !== null) {
      result[key] = maskPiiInObject(value);
    } else {
      result[key] = value;
    }
  }
  return result;
}

/**
 * Create a safe log string by masking PII.
 * Usage: console.log(maskPii`Client ${phone} scored ${score}`);
 */
function maskPii(strings, ...values) {
  let result = '';
  strings.forEach((str, i) => {
    result += str;
    if (i < values.length) {
      const val = String(values[i]);
      // Auto-detect phone-like values (10+ digits)
      if (/^\+?\d{10,}$/.test(val.replace(/\D/g, ''))) {
        result += maskPhone(val);
      } else {
        result += val;
      }
    }
  });
  return result;
}

module.exports = { maskPhone, maskName, maskBin, maskEmail, maskPiiInObject, maskPii };
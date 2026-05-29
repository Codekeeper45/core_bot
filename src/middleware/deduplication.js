'use strict';

/**
 * Message Deduplication Middleware
 * 
 * Prevents processing the same message twice (WhatsApp sometimes sends duplicates).
 * Uses an in-memory LRU cache with 5-minute TTL.
 */

const recentMessages = new Map();
// Provider re-deliveries (WhatsApp/Telegram/Wazzup webhook retries) arrive within
// seconds. A short window catches those without eating a legitimate repeat (e.g. a
// client sending "да" again a couple of minutes later for a different question).
const DEDUP_TTL_MS = 90 * 1000; // 90 seconds
const MAX_CACHE_SIZE = 10000;

/**
 * Check if a message has already been processed.
 * Returns true if the message is a duplicate (should be skipped).
 */
function isDuplicate(channel, chatId, content) {
  // Full composite string key — no 32-bit hash, so distinct messages can't collide
  // and get silently dropped.
  const key = `${channel}:${chatId}:${content}`;
  const now = Date.now();

  const seenAt = recentMessages.get(key);
  if (seenAt !== undefined && (now - seenAt) < DEDUP_TTL_MS) {
    return true; // genuine duplicate within the window
  }

  recentMessages.set(key, now);

  // Bound memory: drop expired entries once the cache grows large.
  if (recentMessages.size > MAX_CACHE_SIZE) {
    for (const [k, ts] of recentMessages) {
      if (now - ts > DEDUP_TTL_MS) recentMessages.delete(k);
    }
  }
  return false;
}

module.exports = { isDuplicate };
const WINDOW_MS = 60 * 1000;
const MAX_MESSAGES = 10;

const rateLimits = new Map();
const MAX_TRACKED_CHATS = 5000;

function checkRateLimit(channel, chatId) {
  const key = `${channel}:${chatId}`;
  const now = Date.now();

  const timestamps = rateLimits.get(key) || [];
  const recentTimestamps = timestamps.filter((timestamp) => now - timestamp < WINDOW_MS);

  recentTimestamps.push(now);
  rateLimits.set(key, recentTimestamps);

  // Bound memory: idle chats keep an entry forever otherwise. Sweep stale ones
  // (no message within the window) once the map grows large.
  if (rateLimits.size > MAX_TRACKED_CHATS) {
    for (const [k, arr] of rateLimits) {
      if (!arr.length || now - arr[arr.length - 1] >= WINDOW_MS) rateLimits.delete(k);
    }
  }

  if (recentTimestamps.length > MAX_MESSAGES) {
    return {
      limited: true,
      message: 'Подождите немного, я обрабатываю ваше предыдущее сообщение.',
    };
  }

  return { limited: false };
}

module.exports = { checkRateLimit };

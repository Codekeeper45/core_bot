'use strict';

// In-memory concurrency guard — single process, no Redis needed
const activeLocks = new Set();
const queues = new Map();

async function acquireLock(channel, chatId) {
  const key = `${channel}:${chatId}`;
  if (activeLocks.has(key)) return false;
  activeLocks.add(key);
  return true;
}

async function enqueue(channel, chatId, messageData) {
  const key = `${channel}:${chatId}`;
  if (!queues.has(key)) queues.set(key, []);
  queues.get(key).push(messageData);
}

async function releaseLockAndProcessQueue(channel, chatId, processMessage) {
  const key = `${channel}:${chatId}`;
  const queue = queues.get(key);

  if (queue && queue.length > 0) {
    const next = queue.shift();
    if (queue.length === 0) queues.delete(key);
    activeLocks.delete(key);
    setImmediate(() => processMessage(next).catch(err => console.error('[Concurrency] Queue error:', err.message)));
  } else {
    queues.delete(key);
    activeLocks.delete(key);
  }
}

module.exports = { acquireLock, enqueue, releaseLockAndProcessQueue };

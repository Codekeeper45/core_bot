'use strict';

/**
 * Retry utility with exponential backoff.
 * 
 * Usage:
 *   const result = await withRetry(fn, { maxRetries: 3, baseDelay: 1000 });
 * 
 * On final failure, throws the last error.
 */
async function withRetry(fn, options = {}) {
  const { maxRetries = 3, baseDelay = 1000, maxDelay = 10000, onRetry } = options;
  let lastError;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt >= maxRetries) break;

      const is429 = err.message && err.message.includes('429');
      const rawDelay = is429
        ? 8000 + Math.random() * 2000  // 8-10s for rate limit errors
        : Math.min(baseDelay * Math.pow(2, attempt - 1), maxDelay);
      const jitter = is429 ? 0 : Math.random() * 200;
      const totalDelay = rawDelay + jitter;

      console.warn(`[Retry] Attempt ${attempt}/${maxRetries} failed: ${err.message}. Retrying in ${Math.round(totalDelay)}ms...`);

      if (onRetry) {
        onRetry(attempt, err);
      }

      await new Promise(resolve => setTimeout(resolve, totalDelay));
    }
  }

  throw lastError;
}

module.exports = { withRetry };
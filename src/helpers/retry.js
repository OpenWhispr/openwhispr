/**
 * CJS port of src/utils/retry.ts — needed by ipcHandlers.js (CommonJS).
 * Retry constants inlined from src/config/constants.ts.
 */

const RETRY_CONFIG = {
  MAX_RETRIES: 3,
  INITIAL_DELAY: 1000,
  MAX_DELAY: 10000,
  BACKOFF_MULTIPLIER: 2,
};

async function withRetry(fn, options = {}) {
  const {
    maxRetries = RETRY_CONFIG.MAX_RETRIES,
    initialDelay = RETRY_CONFIG.INITIAL_DELAY,
    maxDelay = RETRY_CONFIG.MAX_DELAY,
    backoffMultiplier = RETRY_CONFIG.BACKOFF_MULTIPLIER,
    shouldRetry = () => true,
  } = options;

  let lastError;
  let delay = initialDelay;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      if (attempt === maxRetries || !shouldRetry(error)) {
        throw error;
      }

      await new Promise((resolve) => setTimeout(resolve, delay));
      delay = Math.min(delay * backoffMultiplier, maxDelay);
    }
  }

  throw lastError;
}

function createApiRetryStrategy() {
  return {
    shouldRetry: (error) => {
      if (!error.status && !error.statusCode && !error.response) return true; // Network error
      const status = error.status || error.statusCode || error.response?.status;
      return status >= 500 && status < 600;
    },
  };
}

module.exports = { withRetry, createApiRetryStrategy };

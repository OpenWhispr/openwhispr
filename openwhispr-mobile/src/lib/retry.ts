// Ported from openwhispr/src/utils/retry.ts. Same exponential-backoff semantics
// so mobile cleanup tolerates flaky networks the way desktop does.

const RETRY_CONFIG = {
  MAX_RETRIES: 3,
  INITIAL_DELAY: 1000,
  MAX_DELAY: 10000,
  BACKOFF_MULTIPLIER: 2,
};

export interface RetryOptions {
  maxRetries?: number;
  initialDelay?: number;
  maxDelay?: number;
  backoffMultiplier?: number;
  shouldRetry?: (error: unknown) => boolean;
  onRetry?: (attempt: number, error: unknown, delayMs: number) => void;
}

export async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const {
    maxRetries = RETRY_CONFIG.MAX_RETRIES,
    initialDelay = RETRY_CONFIG.INITIAL_DELAY,
    maxDelay = RETRY_CONFIG.MAX_DELAY,
    backoffMultiplier = RETRY_CONFIG.BACKOFF_MULTIPLIER,
    shouldRetry = () => true,
    onRetry,
  } = options;

  let lastError: unknown;
  let delay = initialDelay;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      if (attempt === maxRetries || !shouldRetry(error)) {
        throw error;
      }

      onRetry?.(attempt + 1, error, delay);
      await new Promise((resolve) => setTimeout(resolve, delay));
      delay = Math.min(delay * backoffMultiplier, maxDelay);
    }
  }

  throw lastError;
}

// Retry network errors and 5xx server errors. 4xx errors (bad request, auth)
// are deterministic and won't recover from a retry.
export function createApiRetryStrategy(): RetryOptions {
  return {
    shouldRetry: (error: unknown) => {
      const status =
        typeof error === 'object' && error !== null && 'status' in error
          ? (error as { status?: number }).status
          : undefined;

      if (status === undefined) return true; // network error, no HTTP response
      return status >= 500 && status < 600;
    },
  };
}

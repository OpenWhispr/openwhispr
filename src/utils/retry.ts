import { RETRY_CONFIG } from "../config/constants.ts";

export interface RetryOptions {
  maxRetries?: number;
  initialDelay?: number;
  maxDelay?: number;
  backoffMultiplier?: number;
  shouldRetry?: (error: any) => boolean;
}

export async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const {
    maxRetries = RETRY_CONFIG.MAX_RETRIES,
    initialDelay = RETRY_CONFIG.INITIAL_DELAY,
    maxDelay = RETRY_CONFIG.MAX_DELAY,
    backoffMultiplier = RETRY_CONFIG.BACKOFF_MULTIPLIER,
    shouldRetry = () => true,
  } = options;

  let lastError: any;
  let delay = initialDelay;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      if (attempt === maxRetries || !shouldRetry(error)) {
        throw error;
      }

      // Wait before retrying with exponential backoff
      await new Promise((resolve) => setTimeout(resolve, delay));
      delay = Math.min(delay * backoffMultiplier, maxDelay);
    }
  }

  throw lastError;
}

// Status lets createApiRetryStrategy tell an HTTP rejection from a network fault.
export function httpError(message: string, status: number): Error & { status: number } {
  return Object.assign(new Error(message), { status });
}

// Marks a client-side abort that fired after the full per-attempt timeout.
// Unlike a network drop, the request *was* being answered — too slowly — and
// each retry re-spends the entire budget relearning that (#1761).
export function timeoutError(message: string): Error & { timedOut: true } {
  return Object.assign(new Error(message), { timedOut: true as const });
}

// The OpenAI SDK (Tinfoil path) raises its own status-less timeout class
// instead of going through timeoutError().
function isClientTimeout(error: any): boolean {
  return error?.timedOut === true || error?.name === "APIConnectionTimeoutError";
}

// Specific retry strategy for API calls
export function createApiRetryStrategy() {
  return {
    shouldRetry: (error: any) => {
      // A timeout already consumed its whole budget proving the server slow;
      // retrying it costs another full budget per attempt (127 s measured
      // before the raw-paste fallback in #1761). Fail over instead.
      if (isClientTimeout(error)) return false;

      // No HTTP status means the request never got an answer (network drop).
      const status = error?.status ?? error?.response?.status;
      if (typeof status !== "number") return true;

      // Most 4xx are deterministic rejections. 408 is a request timeout and 429 is
      // a rate limit; both can clear on retry, as can 5xx server faults.
      return status === 408 || status === 429 || (status >= 500 && status < 600);
    },
  };
}

// Specific retry strategy for file operations
export function createFileRetryStrategy() {
  return {
    shouldRetry: (error: any) => {
      // Retry on temporary file system errors
      const retriableErrors = ["EBUSY", "ENOENT", "EPERM", "EAGAIN"];
      return retriableErrors.includes(error.code);
    },
    maxRetries: 2,
    initialDelay: 500,
  };
}

export type UsageLimitSource = 'transcription' | 'agent' | 'unknown';

type UsageLimitErrorOptions = {
  source?: UsageLimitSource;
  cause?: unknown;
};

export class UsageLimitError extends Error {
  readonly status = 429;
  readonly source: UsageLimitSource;

  constructor(message = 'Weekly word limit reached', options: UsageLimitErrorOptions = {}) {
    super(message);
    this.name = 'UsageLimitError';
    this.source = options.source ?? 'unknown';
    if (options.cause !== undefined) {
      this.cause = options.cause;
    }
  }
}

export function isUsageLimitError(error: unknown): error is UsageLimitError {
  return (
    error instanceof UsageLimitError ||
    (typeof error === 'object' &&
      error !== null &&
      (error as { name?: string; status?: number }).name === 'UsageLimitError' &&
      (error as { status?: number }).status === 429)
  );
}

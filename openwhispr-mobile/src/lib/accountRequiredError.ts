/** The code the API returns when an endpoint refuses an anonymous session. */
export const ACCOUNT_REQUIRED_CODE = 'ACCOUNT_REQUIRED';

/**
 * Raised where the transport cannot carry the server's code on its own — the
 * transcription upload reads a raw status and body rather than going through
 * apiClient. Mirrors UsageLimitError, the other typed API refusal.
 */
export class AccountRequiredError extends Error {
  readonly status = 403;
  readonly code = ACCOUNT_REQUIRED_CODE;

  constructor(message = 'Create an account to use this feature') {
    super(message);
    this.name = 'AccountRequiredError';
  }
}

/**
 * True for any error carrying the server's ACCOUNT_REQUIRED code, whichever
 * transport raised it: apiClient's ApiError, the agent stream, or the
 * transcription upload. Duck-typed on `code` so it survives being re-thrown or
 * crossing a module boundary.
 */
export function isAccountRequiredError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === ACCOUNT_REQUIRED_CODE
  );
}

import {
  getValidatedAuthGeneration,
  invalidateValidatedAuthContext,
  readAuthTokenState,
} from "../lib/authRequestContext";
import { recordServerDate } from "../lib/serverClock";
import i18n from "../i18n";

interface CloudApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  code?: string;
  status?: number;
  serverDate?: string;
  requestSent?: boolean;
}

// Common `{ data: T }` envelope returned by the cloud API.
export interface DataWrap<T> {
  data: T;
}

export class CloudApiError extends Error {
  status: number;
  code?: string;
  details?: unknown;
  /** False when main refused the request before anything left this device. */
  requestSent?: boolean;
  constructor(
    message: string,
    status: number,
    code?: string,
    details?: unknown,
    requestSent?: boolean
  ) {
    super(message);
    this.name = "CloudApiError";
    this.status = status;
    this.code = code;
    this.details = details;
    this.requestSent = requestSent;
  }
}

/**
 * The server's own reason when it refused a request (a 4xx with a message), or null otherwise:
 * the connection, an expired session, or a bare status the main process filled in.
 */
export function serverRefusalMessage(error: unknown): string | null {
  if (!(error instanceof CloudApiError)) return null;
  const { status, message } = error;
  if (status < 400 || status >= 500 || status === 401) return null;
  return message === `API error: ${status}` ? null : message;
}

async function cloudRequest<T = unknown>(
  method: string,
  path: string,
  body?: unknown,
  isPublic?: boolean,
  authGenerationOverride?: number
): Promise<T> {
  const expectedAuthGeneration = isPublic
    ? undefined
    : (authGenerationOverride ?? getValidatedAuthGeneration() ?? undefined);
  const result = (await window.electronAPI?.cloudApiRequest?.({
    method,
    path,
    body,
    public: isPublic,
    expectedAuthGeneration,
  })) as (CloudApiResponse<T> & { details?: unknown }) | undefined;
  recordServerDate(result?.serverDate, Date.now());

  if (!result?.success) {
    if (result?.code === "AUTH_CONTEXT_CHANGED" || result?.code === "AUTH_CONTEXT_UNVALIDATED") {
      await readAuthTokenState().catch(() => undefined);
      // A request pinned to a replaced sign-in says nothing about the sign-in
      // that replaced it.
      if (expectedAuthGeneration === getValidatedAuthGeneration()) {
        invalidateValidatedAuthContext();
      }
    }
    throw new CloudApiError(
      // Main's own wording is for logs; this one reaches error toasts.
      result?.code === "AUTH_CONTEXT_UNVALIDATED"
        ? i18n.t("auth.unconfirmedSession")
        : (result?.error ?? "Cloud API request failed"),
      result?.status ?? 0,
      result?.code,
      result?.details,
      result?.requestSent
    );
  }

  return result.data as T;
}

export async function cloudGet<T = unknown>(path: string): Promise<T> {
  return cloudRequest<T>("GET", path);
}

// Account-scoped work may wait behind another renderer operation. Preserve the
// credential generation from the caller so a queued request cannot adopt a
// replacement account's token when it eventually reaches the main process.
export async function cloudGetForAuthGeneration<T = unknown>(
  path: string,
  authGeneration: number
): Promise<T> {
  return cloudRequest<T>("GET", path, undefined, false, authGeneration);
}

// Account-scope bootstrap is the only authenticated call allowed before the
// candidate session generation has been committed for ordinary sync.
export async function cloudGetForAuthValidation<T = unknown>(
  path: "/api/me/spaces",
  generation: number
): Promise<T> {
  return cloudRequest<T>("GET", path, undefined, false, generation);
}

// For endpoints that work without a session (e.g. invitation previews).
export async function cloudGetPublic<T = unknown>(path: string): Promise<T> {
  return cloudRequest<T>("GET", path, undefined, true);
}

export async function cloudPost<T = unknown>(path: string, body?: unknown): Promise<T> {
  return cloudRequest<T>("POST", path, body);
}

export async function cloudPostForAuthGeneration<T = unknown>(
  path: string,
  body: unknown,
  authGeneration: number
): Promise<T> {
  return cloudRequest<T>("POST", path, body, false, authGeneration);
}

export async function cloudPatch<T = unknown>(path: string, body?: unknown): Promise<T> {
  return cloudRequest<T>("PATCH", path, body);
}

export async function cloudPatchForAuthGeneration<T = unknown>(
  path: string,
  body: unknown,
  authGeneration: number
): Promise<T> {
  return cloudRequest<T>("PATCH", path, body, false, authGeneration);
}

export async function cloudDelete<T = unknown>(path: string, body?: unknown): Promise<T> {
  return cloudRequest<T>("DELETE", path, body);
}

export async function cloudDeleteForAuthGeneration<T = unknown>(
  path: string,
  body: unknown,
  authGeneration: number
): Promise<T> {
  return cloudRequest<T>("DELETE", path, body, false, authGeneration);
}

// An auth refusal raised after the request left says nothing about whether the
// server acted on it.
export function wasRefusedBeforeSending(error: unknown): boolean {
  return error instanceof CloudApiError && isAuthContextError(error) && error.requestSent === false;
}

export function isAuthContextError(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) return false;
  const code = (error as { code?: unknown }).code;
  return code === "AUTH_CONTEXT_CHANGED" || code === "AUTH_CONTEXT_UNVALIDATED";
}

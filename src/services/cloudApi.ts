import {
  getValidatedAuthGeneration,
  invalidateValidatedAuthContext,
  readAuthTokenState,
} from "../lib/authRequestContext";

interface CloudApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  code?: string;
  status?: number;
}

// Common `{ data: T }` envelope returned by the cloud API.
export interface DataWrap<T> {
  data: T;
}

export class CloudApiError extends Error {
  status: number;
  code?: string;
  details?: unknown;
  constructor(message: string, status: number, code?: string, details?: unknown) {
    super(message);
    this.name = "CloudApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
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

  if (!result?.success) {
    if (result?.code === "AUTH_CONTEXT_CHANGED" || result?.code === "AUTH_CONTEXT_UNVALIDATED") {
      await readAuthTokenState().catch(() => undefined);
      invalidateValidatedAuthContext();
    }
    throw new CloudApiError(
      result?.error ?? "Cloud API request failed",
      result?.status ?? 0,
      result?.code,
      result?.details
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

export function isAuthContextError(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) return false;
  const code = (error as { code?: unknown }).code;
  return code === "AUTH_CONTEXT_CHANGED" || code === "AUTH_CONTEXT_UNVALIDATED";
}

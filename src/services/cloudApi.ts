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

export async function cloudPatch<T = unknown>(path: string, body?: unknown): Promise<T> {
  return cloudRequest<T>("PATCH", path, body);
}

export async function cloudDelete<T = unknown>(path: string, body?: unknown): Promise<T> {
  return cloudRequest<T>("DELETE", path, body);
}

export function isAuthContextError(error: unknown): boolean {
  return (
    error instanceof CloudApiError &&
    (error.code === "AUTH_CONTEXT_CHANGED" || error.code === "AUTH_CONTEXT_UNVALIDATED")
  );
}

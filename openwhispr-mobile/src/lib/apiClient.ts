import { fetch } from 'expo/fetch';
import Constants from 'expo-constants';
import { useAuthStore } from '@/store/useAuthStore';
import { parseApiErrorBody } from '@/lib/apiErrorBody';
import { UPGRADE_REQUIRED_MESSAGE } from './policyMessages';

// Re-exported so existing consumers (e.g. AgentStreamClient.ts, which already
// imports from this module) can keep pulling it from one place; the
// canonical definition lives in policyMessages.ts (see that file for why).
export { UPGRADE_REQUIRED_MESSAGE };

export const BASE_URL = process.env.EXPO_PUBLIC_API_URL || 'https://api.openwhispr.com';

/** Returns auth headers for authenticated requests, or an empty object when no session exists. */
export function getAuthHeaders(): Record<string, string> {
  const { sessionCookie } = useAuthStore.getState();
  return sessionCookie ? { Cookie: sessionCookie } : {};
}

// Org-policy enforcement (POLICY_CLOUD_BACKUP_BLOCKED on sync writes) is
// header-gated server-side: only clients sending this header get the block.
// Fixed at "1" — there is no negotiation, just an opt-in signal.
const POLICY_VERSION_HEADER = 'x-openwhispr-policy-version';
const POLICY_VERSION = '1';

/**
 * Returns the client identification headers sent on every request: the app
 * version (omitted when unknown), mobile platform, and policy-awareness opt-in.
 * The platform keeps mobile releases out of the desktop minimum-version gate.
 */
export function getClientVersionHeader(): Record<string, string> {
  const version = Constants.expoConfig?.version;
  return {
    ...(version ? { 'x-openwhispr-version': version } : {}),
    'x-openwhispr-platform': 'mobile',
    [POLICY_VERSION_HEADER]: POLICY_VERSION,
  };
}

interface FetchOptions {
  authenticated?: boolean;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
}

// Thrown for non-2xx HTTP responses. Carries the status so retry strategies
// can distinguish 4xx (don't retry) from 5xx (retry) without re-parsing, and
// the server's machine-readable code where it sent one (e.g. ACCOUNT_REQUIRED).
export class ApiError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly data?: unknown;

  constructor(message: string, status: number, code?: string, data?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.data = data;
  }
}

export const POLICY_MODE_BLOCKED_CODE = 'POLICY_MODE_BLOCKED';
export const POLICY_CLOUD_BACKUP_BLOCKED_CODE = 'POLICY_CLOUD_BACKUP_BLOCKED';

/** True for a 403 rejecting cloud transcription/AI under an org policy. */
export function isPolicyModeBlockedError(error: unknown): boolean {
  return (
    error instanceof ApiError && error.status === 403 && error.code === POLICY_MODE_BLOCKED_CODE
  );
}

/** True for a 403 rejecting a sync write because an org turned cloud backup off. */
export function isPolicyCloudBackupBlockedError(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    error.status === 403 &&
    error.code === POLICY_CLOUD_BACKUP_BLOCKED_CODE
  );
}

export async function apiRequest<T>(path: string, options: FetchOptions = {}): Promise<T> {
  const { authenticated = true, ...fetchOptions } = options;

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...getClientVersionHeader(),
    ...((fetchOptions.headers as Record<string, string>) || {}),
  };

  if (authenticated) {
    const { sessionCookie } = useAuthStore.getState();
    if (sessionCookie) {
      headers.Cookie = sessionCookie;
    }
  }

  const res = await fetch(`${BASE_URL}${path}`, {
    ...fetchOptions,
    headers,
  });

  if (!res.ok) {
    const { message, code, data } = parseApiErrorBody(await res.json().catch(() => ({})));
    throw new ApiError(
      res.status === 426 ? UPGRADE_REQUIRED_MESSAGE : message || `HTTP ${res.status}`,
      res.status,
      code,
      data,
    );
  }

  // Endpoints that return 204 No Content (e.g. DELETE) have no body to parse.
  if (res.status === 204) return undefined as T;

  return res.json();
}

export const api = {
  get: <T>(path: string, options?: FetchOptions) =>
    apiRequest<T>(path, { method: 'GET', ...options }),

  post: <T>(path: string, body?: unknown, options?: FetchOptions) =>
    apiRequest<T>(path, {
      method: 'POST',
      body: body ? JSON.stringify(body) : undefined,
      ...options,
    }),

  patch: <T>(path: string, body?: unknown, options?: FetchOptions) =>
    apiRequest<T>(path, {
      method: 'PATCH',
      body: body ? JSON.stringify(body) : undefined,
      ...options,
    }),

  delete: <T>(path: string, body?: unknown, options?: FetchOptions) =>
    apiRequest<T>(path, {
      method: 'DELETE',
      body: body ? JSON.stringify(body) : undefined,
      ...options,
    }),
};

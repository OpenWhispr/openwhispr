import { fetch } from 'expo/fetch';
import { debugLog, hostOf, routeOf, safeError, startTimer } from './debugLog';

const API_HOST = hostOf(process.env.EXPO_PUBLIC_API_URL || 'https://api.openwhispr.com');

function urlOf(input: unknown): string {
  if (typeof input === 'string') return input;
  if (input && typeof input === 'object' && 'url' in input) return String((input as { url: string }).url);
  return String(input);
}

/**
 * One debug-log line per request: method, route (the OpenWhispr API's path with query values
 * dropped; only the host for anyone else), status, time and the request id header.
 */
function logRequest(
  method: string,
  url: string,
  ms: number,
  response?: { status: number; headers?: { get(name: string): string | null } },
  error?: unknown,
): void {
  const host = hostOf(url);
  const route = host === API_HOST ? `${method} ${routeOf(url)}` : `${method} ${host}`;
  const req = response?.headers?.get?.('x-request-id') ?? response?.headers?.get?.('x-vercel-id') ?? undefined;
  if (error !== undefined) {
    const aborted = (error as { name?: string } | null)?.name === 'AbortError';
    debugLog('net', aborted ? 'aborted' : 'failed', { route, ms, error: aborted ? undefined : safeError(error) }, aborted ? 'I' : 'W');
    return;
  }
  const status = response?.status ?? 0;
  debugLog('net', 'request', { route, status, ms, req }, status >= 500 ? 'E' : status >= 400 ? 'W' : 'I');
}

// Prevent Android's shared native cookie jar from replacing the explicit account cookie.
export const sessionFetch: typeof fetch = async (input, init) => {
  const elapsed = startTimer();
  const method = (init?.method ?? 'GET').toUpperCase();
  const url = urlOf(input);
  try {
    const response = await fetch(input, { ...init, credentials: 'omit' });
    try {
      logRequest(method, url, elapsed(), response);
    } catch {
      /* Logging never breaks a request. */
    }
    return response;
  } catch (error) {
    try {
      logRequest(method, url, elapsed(), undefined, error);
    } catch {
      /* ignore */
    }
    throw error;
  }
};

export { logRequest as logDebugRequest };

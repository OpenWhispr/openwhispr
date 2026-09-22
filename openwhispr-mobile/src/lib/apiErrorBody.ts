export interface ApiErrorBody {
  message?: string;
  code?: string;
  data?: unknown;
}

/**
 * Normalizes every error envelope the API returns, so a caller never has to
 * guess which one an endpoint uses:
 *
 *   { error: 'msg' }                  most app endpoints
 *   { error: 'msg', code: 'CODE' }    the ACCOUNT_REQUIRED gate
 *   { error: 'msg', code, data }      org-policy rejections, with a payload
 *   { error: { code, message } }      /api/v1/* and session-token auth
 *   { message, code }                 Better Auth
 *
 * Reading only `.message` — as this client used to — drops both the text and
 * the code for the first two, which is why a gated endpoint surfaced as a bare
 * "HTTP 403". Accepts a parsed body or a raw string.
 */
export function parseApiErrorBody(body: unknown): ApiErrorBody {
  if (typeof body === 'string') {
    try {
      return parseApiErrorBody(JSON.parse(body) as unknown);
    } catch {
      return {};
    }
  }
  if (typeof body !== 'object' || body === null) return {};

  const { error, message, code, data } = body as {
    error?: unknown;
    message?: unknown;
    code?: unknown;
    data?: unknown;
  };

  if (error !== null && typeof error === 'object') {
    const nested = error as { message?: unknown; code?: unknown };
    return {
      message: typeof nested.message === 'string' ? nested.message : undefined,
      code: typeof nested.code === 'string' ? nested.code : undefined,
      data,
    };
  }

  return {
    message:
      typeof error === 'string' && error
        ? error
        : typeof message === 'string' && message
          ? message
          : undefined,
    code: typeof code === 'string' ? code : undefined,
    data,
  };
}

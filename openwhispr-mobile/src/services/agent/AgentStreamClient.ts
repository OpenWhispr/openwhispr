import { fetch } from 'expo/fetch';
import {
  BASE_URL,
  getAuthHeaders,
  getClientVersionHeader,
  ApiError,
  UPGRADE_REQUIRED_MESSAGE,
} from '@/lib/apiClient';
import { parseApiErrorBody } from '@/lib/apiErrorBody';
import { withRetry } from '@/lib/retry';

// Single budget for the entire streaming call: connect + receive.
const AGENT_STREAM_TIMEOUT_MS = 55_000;

// Max 1 retry — words are billed at /api/transcribe, not here.
const AGENT_MAX_RETRIES = 1;

export interface AgentMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface StreamAgentTextOptions {
  messages: AgentMessage[];
  systemPrompt?: string;
  sessionId?: string;
  /** External cancellation signal. Combined with the internal timeout budget. */
  signal?: AbortSignal;
  /** Override max retries (used in tests to reduce retry delay). */
  maxRetries?: number;
}

// ---------------------------------------------------------------------------
// Signal combination helpers
// ---------------------------------------------------------------------------

/**
 * Returns a combined signal that aborts when either `a` or `b` fires.
 * Mirrors what AbortSignal.any() does, but that API may not be available in
 * all React Native runtimes.
 */
function combineSignals(a: AbortSignal, b: AbortSignal): AbortSignal {
  if (typeof AbortSignal.any === 'function') {
    return AbortSignal.any([a, b]);
  }
  const combined = new AbortController();
  const abort = (): void => combined.abort();
  if (a.aborted || b.aborted) {
    combined.abort();
    return combined.signal;
  }
  a.addEventListener('abort', abort, { once: true });
  b.addEventListener('abort', abort, { once: true });
  // Clean up listeners when the combined controller aborts.
  combined.signal.addEventListener(
    'abort',
    () => {
      a.removeEventListener('abort', abort);
      b.removeEventListener('abort', abort);
    },
    { once: true },
  );
  return combined.signal;
}

// ---------------------------------------------------------------------------
// NDJSON stream parser
// ---------------------------------------------------------------------------

/**
 * A class that marks stream-level errors (error line, premature end) as
 * retryable so withRetry can attempt a second call.
 */
class RetryableStreamError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RetryableStreamError';
  }
}

/**
 * Reads a ReadableStream body via its reader, splits on `\n`, parses each
 * NDJSON line, accumulates `{type:'content', text}` values, and resolves when
 * `{type:'done'}` is received.
 *
 * Throws RetryableStreamError on `{type:'error'}` or stream end without done.
 */
async function readNdjsonStream(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<string> {
  const decoder = new TextDecoder();
  let buffer = '';
  const parts: string[] = [];

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      const remaining = buffer.trim();
      if (remaining) {
        try {
          const parsed = JSON.parse(remaining) as Record<string, unknown>;
          if (parsed.type === 'done') {
            return parts.join('');
          }
          if (parsed.type === 'error') {
            throw new RetryableStreamError(
              typeof parsed.message === 'string' ? parsed.message : 'Stream error',
            );
          }
        } catch (err) {
          if (err instanceof RetryableStreamError) throw err;
          // Malformed JSON in the last fragment — fall through to no-done error
        }
      }
      throw new RetryableStreamError('Stream ended without a done marker');
    }

    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split('\n');
    // Keep the last element (potentially incomplete line) in the buffer
    buffer = lines.pop() ?? '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(trimmed) as Record<string, unknown>;
      } catch {
        // Malformed line — skip; the buffer will accumulate the rest
        continue;
      }

      if (parsed.type === 'content' && typeof parsed.text === 'string') {
        parts.push(parsed.text);
      } else if (parsed.type === 'done') {
        return parts.join('');
      } else if (parsed.type === 'error') {
        throw new RetryableStreamError(
          typeof parsed.message === 'string' ? parsed.message : 'Stream error',
        );
      }
      // Unknown types (e.g. tool_call) are silently skipped.
    }
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Streams a multi-turn agent completion from /api/agent/stream.
 *
 * Resolves with the full accumulated text once the server sends a done marker.
 * Retries up to AGENT_MAX_RETRIES times on retryable failures (stream error
 * lines, premature stream end). Throws ApiError on non-2xx responses.
 */
export async function streamAgentText(options: StreamAgentTextOptions): Promise<string> {
  const { messages, systemPrompt, sessionId, signal: externalSignal, maxRetries } = options;

  const shouldRetry = (error: unknown): boolean => {
    // Never retry a cancelled/superseded call — the abort was intentional
    // (external signal or the composer's supersede rule), so a retry would just
    // burn the single budget before being dropped.
    if ((error as Error)?.name === 'AbortError') return false;
    // Never retry on ApiError (non-2xx) — these are deterministic.
    if (error instanceof ApiError) return false;
    if (error instanceof RetryableStreamError) return true;
    return true;
  };

  return withRetry(
    async () => {
      const timeoutController = new AbortController();
      const timeoutId = setTimeout(() => timeoutController.abort(), AGENT_STREAM_TIMEOUT_MS);

      const signal = externalSignal
        ? combineSignals(externalSignal, timeoutController.signal)
        : timeoutController.signal;

      try {
        const res = await fetch(`${BASE_URL}/api/agent/stream`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...getAuthHeaders(),
            // Hand-rolls its own fetch instead of going through apiClient's
            // apiRequest, so it must wire the client-identification headers
            // (version + policy opt-in) in itself.
            ...getClientVersionHeader(),
          },
          body: JSON.stringify({
            messages,
            ...(systemPrompt != null ? { systemPrompt } : {}),
            ...(sessionId != null ? { sessionId } : {}),
            clientType: 'mobile',
          }),
          signal,
        });

        if (!res.ok) {
          const { message, code } = parseApiErrorBody(
            await res.json().catch(() => ({ message: res.statusText })),
          );
          if (res.status === 403 && code === 'POLICY_MODE_BLOCKED') {
            throw new ApiError(
              "Your organization's policy doesn't allow OpenWhispr cloud AI.",
              res.status,
              code,
            );
          }
          if (res.status === 426) {
            // Never let "HTTP 426" or a raw server string reach the user.
            throw new ApiError(UPGRADE_REQUIRED_MESSAGE, res.status, code);
          }
          throw new ApiError(message || `HTTP ${res.status}`, res.status, code);
        }

        const reader = res.body?.getReader() as ReadableStreamDefaultReader<Uint8Array> | undefined;
        if (!reader) {
          throw new RetryableStreamError('Response body is not readable');
        }

        return await readNdjsonStream(reader);
      } finally {
        clearTimeout(timeoutId);
      }
    },
    {
      maxRetries: maxRetries ?? AGENT_MAX_RETRIES,
      shouldRetry,
    },
  );
}

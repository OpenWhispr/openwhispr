// jest.mock is hoisted above imports, so the mock factory cannot close over
// variables declared in module scope. Use jest.fn() inside the factory and
// retrieve the mock via require() after imports.
jest.mock('expo/fetch', () => ({
  __esModule: true,
  fetch: jest.fn(),
}));

jest.mock('@/store/useAuthStore', () => ({
  useAuthStore: {
    getState: () => ({ sessionCookie: 'test-session-cookie' }),
  },
}));

import { streamAgentText, type AgentMessage } from '../AgentStreamClient';
import { ApiError } from '@/lib/apiClient';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const mockFetch = (require('expo/fetch') as { fetch: jest.Mock }).fetch;

// ---------------------------------------------------------------------------
// Helpers for building fake ReadableStream readers
// ---------------------------------------------------------------------------

function makeReader(chunks: string[]): {
  read: () => Promise<{ done: boolean; value: Uint8Array | undefined }>;
} {
  const encoder = new TextEncoder();
  let index = 0;
  return {
    read: async () => {
      if (index >= chunks.length) {
        return { done: true, value: undefined };
      }
      return { done: false, value: encoder.encode(chunks[index++]) };
    },
  };
}

function ndjsonLine(obj: Record<string, unknown>): string {
  return JSON.stringify(obj) + '\n';
}

function setupFetch(chunks: string[], status = 200, ok = true): void {
  mockFetch.mockResolvedValue({
    ok,
    status,
    statusText: ok ? 'OK' : 'Error',
    json: async () => ({ message: `HTTP ${status}` }),
    body: { getReader: () => makeReader(chunks) },
  });
}

const BASE_MESSAGES: AgentMessage[] = [{ role: 'user', content: 'hello' }];

beforeEach(() => {
  jest.clearAllMocks();
  jest.useFakeTimers();
});

afterEach(() => {
  jest.useRealTimers();
});

// ---------------------------------------------------------------------------
// NDJSON parser: chunk-boundary splits
// ---------------------------------------------------------------------------

describe('NDJSON parser', () => {
  it('handles a JSON line split across two chunks', async () => {
    const line = ndjsonLine({ type: 'content', text: 'hello' });
    const half = Math.floor(line.length / 2);
    setupFetch([
      line.slice(0, half),
      line.slice(half),
      ndjsonLine({ type: 'done', finishReason: 'stop' }),
    ]);

    const result = streamAgentText({ messages: BASE_MESSAGES });
    jest.runAllTimersAsync();
    await expect(result).resolves.toBe('hello');
  });

  it('handles multiple lines delivered in one chunk', async () => {
    setupFetch([
      ndjsonLine({ type: 'content', text: 'foo' }) +
        ndjsonLine({ type: 'content', text: 'bar' }) +
        ndjsonLine({ type: 'done', finishReason: 'stop' }),
    ]);

    const result = streamAgentText({ messages: BASE_MESSAGES });
    jest.runAllTimersAsync();
    await expect(result).resolves.toBe('foobar');
  });

  it('ignores blank lines between NDJSON entries', async () => {
    setupFetch([
      '\n',
      ndjsonLine({ type: 'content', text: 'word' }),
      '\n\n',
      ndjsonLine({ type: 'done', finishReason: 'stop' }),
    ]);

    const result = streamAgentText({ messages: BASE_MESSAGES });
    jest.runAllTimersAsync();
    await expect(result).resolves.toBe('word');
  });

  it('accumulates content lines in order', async () => {
    setupFetch([
      ndjsonLine({ type: 'content', text: 'one ' }),
      ndjsonLine({ type: 'content', text: 'two ' }),
      ndjsonLine({ type: 'content', text: 'three' }),
      ndjsonLine({ type: 'done', finishReason: 'stop' }),
    ]);

    const result = streamAgentText({ messages: BASE_MESSAGES });
    jest.runAllTimersAsync();
    await expect(result).resolves.toBe('one two three');
  });

  it('ignores unknown line types (e.g. tool_call) without failing', async () => {
    setupFetch([
      ndjsonLine({ type: 'content', text: 'hello' }),
      ndjsonLine({ type: 'tool_call', id: 'tc1', name: 'search', arguments: '{}' }),
      ndjsonLine({ type: 'done', finishReason: 'stop' }),
    ]);

    const result = streamAgentText({ messages: BASE_MESSAGES });
    jest.runAllTimersAsync();
    await expect(result).resolves.toBe('hello');
  });
});

// ---------------------------------------------------------------------------
// Failure semantics
// ---------------------------------------------------------------------------

describe('failure semantics', () => {
  it('{type:"error"} line rejects with a retryable error', async () => {
    setupFetch([
      ndjsonLine({ type: 'content', text: 'partial' }),
      ndjsonLine({ type: 'error', message: 'Stream interrupted' }),
    ]);

    const result = streamAgentText({ messages: BASE_MESSAGES, maxRetries: 0 });
    jest.runAllTimersAsync();
    await expect(result).rejects.toThrow('Stream interrupted');
  });

  it('stream ending without a done marker rejects with a retryable error', async () => {
    setupFetch([ndjsonLine({ type: 'content', text: 'partial text' })]);

    const result = streamAgentText({ messages: BASE_MESSAGES, maxRetries: 0 });
    jest.runAllTimersAsync();
    await expect(result).rejects.toThrow(/stream ended/i);
  });

  it('non-2xx response throws ApiError with status', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 503,
      statusText: 'Service Unavailable',
      json: async () => ({ message: 'Service Unavailable' }),
      body: { getReader: () => makeReader([]) },
    });

    const result = streamAgentText({ messages: BASE_MESSAGES, maxRetries: 0 });
    jest.runAllTimersAsync();
    await expect(result).rejects.toThrow(ApiError);
    await expect(streamAgentText({ messages: BASE_MESSAGES, maxRetries: 0 })).rejects.toMatchObject(
      { status: 503 },
    );
  });

  it('429 response throws ApiError with status 429', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 429,
      statusText: 'Too Many Requests',
      json: async () => ({ message: 'Usage limit reached' }),
      body: { getReader: () => makeReader([]) },
    });

    const result = streamAgentText({ messages: BASE_MESSAGES, maxRetries: 0 });
    jest.runAllTimersAsync();
    await expect(result).rejects.toMatchObject({ status: 429 });
  });
});

// ---------------------------------------------------------------------------
// Retry behaviour
// ---------------------------------------------------------------------------

describe('retry behaviour', () => {
  it('retries once after a retryable stream error and resolves on second attempt', async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({}),
        body: {
          getReader: () =>
            makeReader([ndjsonLine({ type: 'error', message: 'Stream interrupted' })]),
        },
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({}),
        body: {
          getReader: () =>
            makeReader([
              ndjsonLine({ type: 'content', text: 'recovered' }),
              ndjsonLine({ type: 'done', finishReason: 'stop' }),
            ]),
        },
      });

    const result = streamAgentText({ messages: BASE_MESSAGES });
    jest.runAllTimersAsync();
    await expect(result).resolves.toBe('recovered');
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('rejects after max 1 retry is exhausted', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({}),
      body: {
        getReader: () => makeReader([ndjsonLine({ type: 'error', message: 'always fails' })]),
      },
    });

    const result = streamAgentText({ messages: BASE_MESSAGES });
    jest.runAllTimersAsync();
    await expect(result).rejects.toThrow('always fails');
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('does NOT retry an AbortError — a cancelled/superseded call drops immediately', async () => {
    // A superseded call aborts mid-flight. Retrying would burn the single budget
    // before the drop, so shouldRetry must return false for AbortError.
    mockFetch.mockRejectedValue(new DOMException('Aborted', 'AbortError'));

    const result = streamAgentText({ messages: BASE_MESSAGES });
    jest.runAllTimersAsync();
    await expect(result).rejects.toThrow(/abort/i);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('does NOT retry an AbortError raised via the external signal', async () => {
    const controller = new AbortController();
    mockFetch.mockImplementation(
      () =>
        new Promise((_, reject) => {
          controller.signal.addEventListener('abort', () =>
            reject(new DOMException('Aborted', 'AbortError')),
          );
        }),
    );

    const result = streamAgentText({ messages: BASE_MESSAGES, signal: controller.signal });
    controller.abort();
    jest.runAllTimersAsync();
    await expect(result).rejects.toThrow(/abort/i);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// External abort signal
// ---------------------------------------------------------------------------

describe('external abort signal', () => {
  it('cancels the request when the external signal fires', async () => {
    const controller = new AbortController();

    mockFetch.mockImplementation(
      () =>
        new Promise((_, reject) => {
          controller.signal.addEventListener('abort', () =>
            reject(new DOMException('Aborted', 'AbortError')),
          );
        }),
    );

    const result = streamAgentText({
      messages: BASE_MESSAGES,
      signal: controller.signal,
      maxRetries: 0,
    });

    controller.abort();
    await expect(result).rejects.toThrow(/Aborted|abort/i);
  });
});

// ---------------------------------------------------------------------------
// Request shape
// ---------------------------------------------------------------------------

describe('request shape', () => {
  it('sends messages, systemPrompt, and sessionId in the POST body', async () => {
    setupFetch([
      ndjsonLine({ type: 'content', text: 'ok' }),
      ndjsonLine({ type: 'done', finishReason: 'stop' }),
    ]);

    const result = streamAgentText({
      messages: [{ role: 'user', content: 'test' }],
      systemPrompt: 'Be concise.',
      sessionId: 'sess-123',
    });
    jest.runAllTimersAsync();
    await result;

    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body).toMatchObject({
      messages: [{ role: 'user', content: 'test' }],
      systemPrompt: 'Be concise.',
      sessionId: 'sess-123',
      clientType: 'mobile',
    });
  });

  it('includes the session Cookie auth header', async () => {
    setupFetch([
      ndjsonLine({ type: 'content', text: 'auth' }),
      ndjsonLine({ type: 'done', finishReason: 'stop' }),
    ]);

    const result = streamAgentText({ messages: BASE_MESSAGES });
    jest.runAllTimersAsync();
    await result;

    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers['Cookie']).toBe('test-session-cookie');
  });

  it('identifies mobile and policy capability on the streaming request', async () => {
    setupFetch([
      ndjsonLine({ type: 'content', text: 'policy' }),
      ndjsonLine({ type: 'done', finishReason: 'stop' }),
    ]);

    const result = streamAgentText({ messages: BASE_MESSAGES });
    jest.runAllTimersAsync();
    await result;

    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers['x-openwhispr-policy-version']).toBe('1');
    expect(headers['x-openwhispr-platform']).toBe('mobile');
  });
});

// ---------------------------------------------------------------------------
// POLICY_MODE_BLOCKED mapping
// ---------------------------------------------------------------------------

describe('POLICY_MODE_BLOCKED mapping', () => {
  it('maps a 403 + POLICY_MODE_BLOCKED response to the exact user-facing message', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 403,
      statusText: 'Forbidden',
      json: async () => ({ error: 'blocked', code: 'POLICY_MODE_BLOCKED' }),
      body: { getReader: () => makeReader([]) },
    });

    const result = streamAgentText({ messages: BASE_MESSAGES, maxRetries: 0 });
    jest.runAllTimersAsync();
    await expect(result).rejects.toThrow(
      "Your organization's policy doesn't allow OpenWhispr cloud AI.",
    );
    await expect(streamAgentText({ messages: BASE_MESSAGES, maxRetries: 0 })).rejects.toMatchObject(
      { status: 403, code: 'POLICY_MODE_BLOCKED' },
    );
  });

  it('leaves an ordinary 403 (no POLICY_MODE_BLOCKED code) unmapped', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 403,
      statusText: 'Forbidden',
      json: async () => ({ error: 'Forbidden' }),
      body: { getReader: () => makeReader([]) },
    });

    const result = streamAgentText({ messages: BASE_MESSAGES, maxRetries: 0 });
    jest.runAllTimersAsync();
    await expect(result).rejects.toMatchObject({ status: 403, message: 'Forbidden' });
  });
});

// ---------------------------------------------------------------------------
// 426 UPGRADE_REQUIRED mapping
// ---------------------------------------------------------------------------

describe('426 UPGRADE_REQUIRED mapping', () => {
  it('maps a 426 response to the exact upgrade message, ignoring the server body', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 426,
      statusText: 'Upgrade Required',
      json: async () => ({ error: 'raw server string', code: 'UPGRADE_REQUIRED' }),
      body: { getReader: () => makeReader([]) },
    });

    const result = streamAgentText({ messages: BASE_MESSAGES, maxRetries: 0 });
    jest.runAllTimersAsync();
    await expect(result).rejects.toThrow('Update OpenWhispr to keep using cloud features.');
    await expect(streamAgentText({ messages: BASE_MESSAGES, maxRetries: 0 })).rejects.toMatchObject(
      { status: 426 },
    );
  });

  it('never surfaces "HTTP 426" even when the body is empty/unparseable', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 426,
      statusText: 'Upgrade Required',
      json: async () => {
        throw new SyntaxError('Unexpected end of JSON input');
      },
      body: { getReader: () => makeReader([]) },
    });

    const result = streamAgentText({ messages: BASE_MESSAGES, maxRetries: 0 });
    jest.runAllTimersAsync();
    await expect(result).rejects.toThrow('Update OpenWhispr to keep using cloud features.');
  });
});

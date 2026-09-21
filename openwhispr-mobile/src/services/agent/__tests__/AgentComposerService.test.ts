// apiClient imports expo/fetch at module level; mock it so the import chain works.
jest.mock('expo/fetch', () => ({
  __esModule: true,
  fetch: jest.fn(),
}));

jest.mock('@/store/useAuthStore', () => ({
  useAuthStore: {
    getState: () => ({ sessionCookie: 'test-cookie' }),
  },
}));

jest.mock('../AgentStreamClient', () => ({
  streamAgentText: jest.fn(),
}));

jest.mock('@/lib/keyboardAgentSync', () => ({
  readKeyboardAgentJob: jest.fn(),
  writeKeyboardAgentResult: jest.fn(),
  clearKeyboardAgentJob: jest.fn(),
  isKeyboardAgentCancelled: jest.fn(() => false),
}));

jest.mock('@/store/useConfigStore', () => ({
  useConfigStore: {
    getState: jest.fn(() => ({
      config: {
        defaultMode: 'cloud',
        languages: ['en'],
        keyboardTone: 'default',
      },
    })),
  },
}));

jest.mock('@/store/useDictionaryStore', () => ({
  useDictionaryStore: {
    getState: jest.fn(() => ({
      entries: [],
      isLoaded: true,
    })),
  },
}));

const mockSaveAgentSessions = jest.fn();
const mockLoadAgentSessions = jest.fn<PersistedAgentSession[] | null, []>(() => null);
const mockClearAgentSessions = jest.fn();
jest.mock('@/services/storage/StorageService', () => ({
  StorageService: {
    saveAgentSessions: (sessions: unknown) => mockSaveAgentSessions(sessions),
    loadAgentSessions: () => mockLoadAgentSessions(),
    clearAgentSessions: () => mockClearAgentSessions(),
  },
}));

import { ApiError } from '@/lib/apiClient';
import { streamAgentText, type StreamAgentTextOptions } from '../AgentStreamClient';
import {
  readKeyboardAgentJob,
  writeKeyboardAgentResult,
  isKeyboardAgentCancelled,
} from '@/lib/keyboardAgentSync';
import { useDictionaryStore } from '@/store/useDictionaryStore';
import {
  generateForJob,
  handleAgentAction,
  clearSession,
  clearAllSessions,
  getActiveSession,
  MAX_WINDOW_TURNS,
  type AgentComposerConfig,
  type AgentAction,
  type PersistedAgentSession,
} from '../AgentComposerService';
import type { KeyboardAgentJob } from '@/lib/keyboardAgentSync';

const mockStreamAgentText = streamAgentText as jest.MockedFunction<typeof streamAgentText>;
const mockReadKeyboardAgentJob = readKeyboardAgentJob as jest.MockedFunction<
  typeof readKeyboardAgentJob
>;
const mockWriteKeyboardAgentResult = writeKeyboardAgentResult as jest.MockedFunction<
  typeof writeKeyboardAgentResult
>;
const mockIsKeyboardAgentCancelled = isKeyboardAgentCancelled as jest.MockedFunction<
  typeof isKeyboardAgentCancelled
>;
const mockUseDictionaryStore = useDictionaryStore as jest.Mocked<typeof useDictionaryStore>;

function makeRequestId(ms: number, suffix = 'x'): string {
  return `${ms}-${suffix}`;
}

function makeAction(overrides: Partial<AgentAction> = {}): AgentAction {
  return {
    type: 'regenerate',
    sessionId: 'session-1',
    requestId: makeRequestId(Date.now()),
    atMs: Date.now(),
    ...overrides,
  };
}

function makeComposeJob(overrides: Partial<KeyboardAgentJob> = {}): KeyboardAgentJob {
  return {
    jobId: 'job-1',
    sessionId: 'session-1',
    kind: 'compose',
    tone: 'default',
    requestedAtMs: Date.now(),
    ...overrides,
  };
}

function makeConfig(): { setKeyboardStatus: jest.Mock; config: AgentComposerConfig } {
  const setKeyboardStatus = jest.fn<void, [string, string | undefined]>();
  return {
    setKeyboardStatus,
    config: { setKeyboardStatus },
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  clearAllSessions();
  mockLoadAgentSessions.mockReturnValue(null);
  mockIsKeyboardAgentCancelled.mockReturnValue(false);
});

// ---------------------------------------------------------------------------
// Happy path: compose
// ---------------------------------------------------------------------------

describe('compose happy path', () => {
  it('creates a new session, streams text, writes result {versions:[text], activeIndex:0}, sets agent_ready', async () => {
    const job = makeComposeJob();
    const instruction = 'Write a thank you email';
    const { setKeyboardStatus, config } = makeConfig();

    mockStreamAgentText.mockResolvedValue('Thank you for your time!');
    mockReadKeyboardAgentJob.mockReturnValue(job);

    await generateForJob(job, instruction, config);

    expect(mockStreamAgentText).toHaveBeenCalledTimes(1);
    const callArgs = mockStreamAgentText.mock.calls[0][0];

    expect(callArgs.messages).toHaveLength(1);
    expect(callArgs.messages[0]).toEqual({ role: 'user', content: instruction });

    expect(callArgs.systemPrompt).toBeDefined();
    expect(typeof callArgs.systemPrompt).toBe('string');

    expect(callArgs.sessionId).toBe(job.sessionId);

    expect(mockWriteKeyboardAgentResult).toHaveBeenCalledWith({
      sessionId: job.sessionId,
      jobId: job.jobId,
      versions: ['Thank you for your time!'],
      activeIndex: 0,
    });

    expect(setKeyboardStatus).toHaveBeenLastCalledWith('agent_ready', undefined);
  });
});

// ---------------------------------------------------------------------------
// follow_up with live session
// ---------------------------------------------------------------------------

describe('follow_up with live session', () => {
  it('extends history, appends new version, newest active', async () => {
    const sessionId = 'session-follow';
    const composeJob = makeComposeJob({ sessionId, jobId: 'job-compose' });
    const followJob = makeComposeJob({
      sessionId,
      jobId: 'job-follow',
      kind: 'follow_up',
    });
    const composeInstruction = 'Write a greeting';
    const followInstruction = 'Make it more formal';
    const composeText = 'Hey there!';
    const followText = 'Dear Sir or Madam,';

    const composeConfig = makeConfig();
    mockStreamAgentText.mockResolvedValueOnce(composeText);
    mockReadKeyboardAgentJob.mockReturnValueOnce(composeJob);

    await generateForJob(composeJob, composeInstruction, composeConfig.config);

    jest.clearAllMocks();
    const followConfig = makeConfig();
    mockStreamAgentText.mockResolvedValue(followText);
    mockReadKeyboardAgentJob.mockReturnValue(followJob);

    await generateForJob(followJob, followInstruction, followConfig.config);

    const callArgs = mockStreamAgentText.mock.calls[0][0];
    expect(callArgs.messages).toHaveLength(3);
    expect(callArgs.messages[0]).toEqual({ role: 'user', content: composeInstruction });
    expect(callArgs.messages[1]).toEqual({ role: 'assistant', content: composeText });
    expect(callArgs.messages[2]).toEqual({
      role: 'user',
      content: `Revise your latest version: ${followInstruction}`,
    });

    expect(mockWriteKeyboardAgentResult).toHaveBeenCalledWith(
      expect.objectContaining({
        versions: [composeText, followText],
        activeIndex: 1,
      }),
    );

    expect(followConfig.setKeyboardStatus).toHaveBeenLastCalledWith('agent_ready', undefined);
  });
});

// ---------------------------------------------------------------------------
// follow_up with no / expired session
// ---------------------------------------------------------------------------

describe('follow_up with no/expired session', () => {
  it('sets agent_error with session_expired detail, never calls streamAgentText', async () => {
    const sessionId = 'nonexistent-session-xyz';
    clearSession(sessionId);

    const followJob = makeComposeJob({
      sessionId,
      jobId: 'job-no-session',
      kind: 'follow_up',
    });

    const { setKeyboardStatus, config } = makeConfig();

    await generateForJob(followJob, 'revise it', config);

    expect(mockStreamAgentText).not.toHaveBeenCalled();
    expect(setKeyboardStatus).toHaveBeenCalledWith('agent_error', 'session_expired');
  });

  it('treats an expired (TTL elapsed) session as missing', async () => {
    jest.useFakeTimers();

    const sessionId = 'session-ttl';
    const composeJob = makeComposeJob({ sessionId, jobId: 'job-compose-ttl' });
    const followJob = makeComposeJob({
      sessionId,
      jobId: 'job-follow-ttl',
      kind: 'follow_up',
    });

    const composeConfig = makeConfig();
    mockStreamAgentText.mockResolvedValueOnce('text');
    mockReadKeyboardAgentJob.mockReturnValueOnce(composeJob);

    await generateForJob(composeJob, 'write something', composeConfig.config);

    jest.advanceTimersByTime(16 * 60 * 1000);

    jest.clearAllMocks();
    const followConfig = makeConfig();
    mockStreamAgentText.mockResolvedValue('revised text');

    await generateForJob(followJob, 'revise it', followConfig.config);

    expect(mockStreamAgentText).not.toHaveBeenCalled();
    expect(followConfig.setKeyboardStatus).toHaveBeenCalledWith('agent_error', 'session_expired');

    jest.useRealTimers();
  });
});

// ---------------------------------------------------------------------------
// 429 ApiError → agent_error + usage_limit
// ---------------------------------------------------------------------------

describe('429 ApiError', () => {
  it('sets agent_error with usage_limit detail', async () => {
    const job = makeComposeJob({ jobId: 'job-429', sessionId: 'session-429' });
    const { setKeyboardStatus, config } = makeConfig();
    mockStreamAgentText.mockRejectedValue(new ApiError('Rate limit exceeded', 429));

    await generateForJob(job, 'write it', config);

    expect(mockWriteKeyboardAgentResult).not.toHaveBeenCalled();
    expect(setKeyboardStatus).toHaveBeenCalledWith('agent_error', 'usage_limit');
  });
});

// The keyboard shows a fixed title per detail; a bare message would read as a
// retryable "Try again" for a refusal that only an account can clear.
describe('403 ACCOUNT_REQUIRED', () => {
  it('sets agent_error with account_required detail', async () => {
    const job = makeComposeJob({ jobId: 'job-403', sessionId: 'session-403' });
    const { setKeyboardStatus, config } = makeConfig();
    mockStreamAgentText.mockRejectedValue(
      new ApiError('Create an account to use this feature', 403, 'ACCOUNT_REQUIRED'),
    );

    await generateForJob(job, 'write it', config);

    expect(mockWriteKeyboardAgentResult).not.toHaveBeenCalled();
    expect(setKeyboardStatus).toHaveBeenCalledWith('agent_error', 'account_required');
  });
});

// ---------------------------------------------------------------------------
// Generic failure → agent_error + message; no stuck agent_generating
// ---------------------------------------------------------------------------

describe('generic failure', () => {
  it('sets agent_error with the error message, never leaves status as agent_generating', async () => {
    const job = makeComposeJob({ jobId: 'job-fail', sessionId: 'session-fail' });
    const { setKeyboardStatus, config } = makeConfig();
    mockStreamAgentText.mockRejectedValue(new Error('network timeout'));

    await generateForJob(job, 'write it', config);

    expect(mockWriteKeyboardAgentResult).not.toHaveBeenCalled();

    const statusCalls = setKeyboardStatus.mock.calls;
    const lastStatus = statusCalls[statusCalls.length - 1]?.[0];
    expect(lastStatus).not.toBe('agent_generating');
    expect(lastStatus).toBe('agent_error');
    expect(statusCalls[statusCalls.length - 1]?.[1]).toBe('network timeout');
  });
});

// ---------------------------------------------------------------------------
// jobId currency: readKeyboardAgentJob returns null at write time → drop silently
// ---------------------------------------------------------------------------

describe('jobId currency check', () => {
  it('drops output and does not write agent_ready when job is no longer current', async () => {
    const job = makeComposeJob({ jobId: 'job-stale', sessionId: 'session-stale' });
    const { setKeyboardStatus, config } = makeConfig();
    mockStreamAgentText.mockResolvedValue('some generated text');
    mockReadKeyboardAgentJob.mockReturnValue(null);

    await generateForJob(job, 'write something', config);

    expect(mockWriteKeyboardAgentResult).not.toHaveBeenCalled();
    expect(setKeyboardStatus).not.toHaveBeenCalledWith('agent_ready', undefined);
  });

  it('drops output when readKeyboardAgentJob returns a different jobId', async () => {
    const job = makeComposeJob({ jobId: 'job-old', sessionId: 'session-mismatch-xyz' });
    const newerJob = makeComposeJob({ jobId: 'job-new', sessionId: 'session-mismatch-xyz' });
    const { setKeyboardStatus, config } = makeConfig();
    mockStreamAgentText.mockResolvedValue('text');
    mockReadKeyboardAgentJob.mockReturnValue(newerJob);

    await generateForJob(job, 'write something', config);

    expect(mockWriteKeyboardAgentResult).not.toHaveBeenCalled();
    expect(setKeyboardStatus).not.toHaveBeenCalledWith('agent_ready', undefined);
  });
});

// ---------------------------------------------------------------------------
// Internal timeout abort (AgentStreamClient's own 55s timeout) must surface as agent_error
// ---------------------------------------------------------------------------

describe('internal timeout abort', () => {
  it("sets agent_error when streamAgentText rejects with AbortError but the call's own controller was NOT aborted", async () => {
    const job = makeComposeJob({ jobId: 'job-timeout', sessionId: 'session-timeout' });
    const { setKeyboardStatus, config } = makeConfig();

    // Simulate AgentStreamClient's internal 55s timeout: rejects with an AbortError
    // while the per-call controller was never aborted.
    const internalTimeoutErr = new Error('The operation was aborted');
    internalTimeoutErr.name = 'AbortError';
    mockStreamAgentText.mockRejectedValue(internalTimeoutErr);

    await generateForJob(job, 'write it', config);

    expect(mockWriteKeyboardAgentResult).not.toHaveBeenCalled();
    expect(setKeyboardStatus).toHaveBeenCalledWith('agent_error', 'The operation was aborted');
  });
});

// ---------------------------------------------------------------------------
// Supersession: aborted in-flight call must NOT write agent_error
// ---------------------------------------------------------------------------

describe('supersession', () => {
  it('aborts call A when call B starts; A rejection (AbortError) writes no status; B sets agent_ready once', async () => {
    const sessionId = 'session-supersede';
    clearSession(sessionId);

    const jobA = makeComposeJob({ sessionId, jobId: 'job-a' });
    const jobB = makeComposeJob({ sessionId, jobId: 'job-b' });

    const { setKeyboardStatus: statusA, config: configA } = makeConfig();
    const { setKeyboardStatus: statusB, config: configB } = makeConfig();

    let abortRejectA!: (err: Error) => void;
    mockStreamAgentText.mockImplementationOnce(
      ({ signal }: StreamAgentTextOptions) =>
        new Promise<string>((_resolve, reject) => {
          abortRejectA = reject;
          signal?.addEventListener('abort', () => {
            const err = new Error('The operation was aborted');
            err.name = 'AbortError';
            reject(err);
          });
        }),
    );

    mockStreamAgentText.mockResolvedValueOnce('Result from B');
    mockReadKeyboardAgentJob.mockReturnValue(jobB);

    const promiseA = generateForJob(jobA, 'write something', configA);
    const promiseB = generateForJob(jobB, 'write something else', configB);

    if (abortRejectA) {
      const err = new Error('The operation was aborted');
      err.name = 'AbortError';
      abortRejectA(err);
    }

    await Promise.all([promiseA, promiseB]);

    expect(statusA).not.toHaveBeenCalledWith('agent_error', expect.anything());

    expect(statusB).toHaveBeenCalledTimes(1);
    expect(statusB).toHaveBeenCalledWith('agent_ready', undefined);

    expect(mockWriteKeyboardAgentResult).toHaveBeenCalledTimes(1);
    expect(mockWriteKeyboardAgentResult).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: 'job-b' }),
    );
  });
});

// ---------------------------------------------------------------------------
// Config: dictionary entries included in system prompt
// ---------------------------------------------------------------------------

describe('config integration', () => {
  it('passes custom dictionary words to buildComposerSystemPrompt', async () => {
    const job = makeComposeJob({ jobId: 'job-dict', sessionId: 'session-dict' });
    const { config } = makeConfig();
    mockUseDictionaryStore.getState.mockReturnValue({
      entries: [
        { word: 'OpenWhispr', source: 'manual' as const, addedAt: null },
        { word: 'TDD', source: 'manual' as const, addedAt: null },
      ],
      isLoaded: true,
      load: jest.fn(),
      reset: jest.fn(),
      addWords: jest.fn(),
      addLearnedWords: jest.fn(),
      removeWord: jest.fn(),
      clearAll: jest.fn(),
    });
    mockStreamAgentText.mockResolvedValue('generated text');
    mockReadKeyboardAgentJob.mockReturnValue(job);

    await generateForJob(job, 'write it', config);

    const systemPrompt = mockStreamAgentText.mock.calls[0][0].systemPrompt ?? '';
    expect(systemPrompt).toContain('OpenWhispr');
    expect(systemPrompt).toContain('TDD');

    mockUseDictionaryStore.getState.mockReturnValue({
      entries: [],
      isLoaded: true,
      load: jest.fn(),
      reset: jest.fn(),
      addWords: jest.fn(),
      addLearnedWords: jest.fn(),
      removeWord: jest.fn(),
      clearAll: jest.fn(),
    });
  });
});

// ---------------------------------------------------------------------------
// Helper: seed a live session via a compose generateForJob so action tests
// operate on a real session the service owns.
// ---------------------------------------------------------------------------

async function seedSession(sessionId: string, composeText = 'Draft one'): Promise<void> {
  const job = makeComposeJob({ sessionId, jobId: `${Date.now()}-seed` });
  mockStreamAgentText.mockResolvedValueOnce(composeText);
  mockReadKeyboardAgentJob.mockReturnValueOnce(job);
  await generateForJob(job, 'write the first draft', makeConfig().config);
  jest.clearAllMocks();
  mockLoadAgentSessions.mockReturnValue(null);
}

// ---------------------------------------------------------------------------
// handleAgentAction — regenerate happy path
// ---------------------------------------------------------------------------

describe('handleAgentAction regenerate', () => {
  it('appends a regenerate user message, streams, pushes v2 (newest active), writes jobId=requestId + original sessionId, agent_ready', async () => {
    const sessionId = 'session-regen';
    await seedSession(sessionId, 'Draft one');

    const requestId = makeRequestId(Date.now() + 10, 'regen');
    const action = makeAction({ sessionId, requestId });
    const { setKeyboardStatus, config } = makeConfig();
    mockStreamAgentText.mockResolvedValue('Draft two, different');

    const before = Date.now();
    await handleAgentAction(action, config);

    expect(mockStreamAgentText).toHaveBeenCalledTimes(1);
    const callArgs = mockStreamAgentText.mock.calls[0][0];
    const last = callArgs.messages[callArgs.messages.length - 1];
    expect(last.role).toBe('user');
    expect(last.content.toLowerCase()).toContain('different');
    expect(callArgs.sessionId).toBe(sessionId);

    expect(setKeyboardStatus).toHaveBeenCalledWith('agent_generating', undefined);

    expect(mockWriteKeyboardAgentResult).toHaveBeenCalledTimes(1);
    const written = mockWriteKeyboardAgentResult.mock.calls[0][0];
    expect(written.jobId).toBe(requestId);
    expect(written.sessionId).toBe(sessionId);
    expect(written.versions).toEqual(['Draft one', 'Draft two, different']);
    expect(written.activeIndex).toBe(1);

    expect(setKeyboardStatus).toHaveBeenLastCalledWith('agent_ready', undefined);

    const session = getActiveSession(sessionId);
    expect(session?.versions).toEqual(['Draft one', 'Draft two, different']);
    expect(session?.lastActivityAtMs).toBeGreaterThanOrEqual(before);
  });

  it('caps versions at 5: a 6th regenerate drops the oldest, activeIndex tracks newest', async () => {
    const sessionId = 'session-cap';
    await seedSession(sessionId, 'v1');

    for (let i = 2; i <= 6; i++) {
      const action = makeAction({
        sessionId,
        requestId: makeRequestId(Date.now() + i, `r${i}`),
      });
      mockStreamAgentText.mockResolvedValueOnce(`v${i}`);
      await handleAgentAction(action, makeConfig().config);
    }

    const written = mockWriteKeyboardAgentResult.mock.calls.at(-1)?.[0];
    expect(written?.versions).toEqual(['v2', 'v3', 'v4', 'v5', 'v6']);
    expect(written?.activeIndex).toBe(4);

    const session = getActiveSession(sessionId);
    expect(session?.versions).toEqual(['v2', 'v3', 'v4', 'v5', 'v6']);
  });

  it('missing/expired session → agent_error/session_expired, no stream call', async () => {
    clearSession('ghost-session');
    const action = makeAction({ sessionId: 'ghost-session' });
    const { setKeyboardStatus, config } = makeConfig();

    await handleAgentAction(action, config);

    expect(mockStreamAgentText).not.toHaveBeenCalled();
    expect(mockWriteKeyboardAgentResult).not.toHaveBeenCalled();
    expect(setKeyboardStatus).toHaveBeenCalledWith('agent_error', 'session_expired');
  });

  it('maps a 429 on the action path to usage_limit', async () => {
    const sessionId = 'session-regen-429';
    await seedSession(sessionId);
    const { setKeyboardStatus, config } = makeConfig();
    mockStreamAgentText.mockRejectedValue(new ApiError('Rate limit exceeded', 429));

    await handleAgentAction(makeAction({ sessionId }), config);

    expect(mockWriteKeyboardAgentResult).not.toHaveBeenCalled();
    expect(setKeyboardStatus).toHaveBeenCalledWith('agent_error', 'usage_limit');
  });

  it('maps a 403 ACCOUNT_REQUIRED on the action path to account_required', async () => {
    const sessionId = 'session-regen-403';
    await seedSession(sessionId);
    const { setKeyboardStatus, config } = makeConfig();
    mockStreamAgentText.mockRejectedValue(
      new ApiError('Create an account to use this feature', 403, 'ACCOUNT_REQUIRED'),
    );

    await handleAgentAction(makeAction({ sessionId }), config);

    expect(mockWriteKeyboardAgentResult).not.toHaveBeenCalled();
    expect(setKeyboardStatus).toHaveBeenCalledWith('agent_error', 'account_required');
  });

  it('maps a generic error on the action path to its message, never leaves agent_generating', async () => {
    const sessionId = 'session-regen-generic';
    await seedSession(sessionId);
    const { setKeyboardStatus, config } = makeConfig();
    mockStreamAgentText.mockRejectedValue(new Error('boom'));

    await handleAgentAction(makeAction({ sessionId }), config);

    const calls = setKeyboardStatus.mock.calls;
    expect(calls[calls.length - 1]?.[0]).toBe('agent_error');
    expect(calls[calls.length - 1]?.[1]).toBe('boom');
  });
});

// ---------------------------------------------------------------------------
// Supersede rule across actions + follow-up jobs (timestamp-prefixed requestId)
// ---------------------------------------------------------------------------

describe('requestId supersede', () => {
  it('action A in-flight; newer action B arrives → A aborted + dropped, B written once', async () => {
    const sessionId = 'session-supersede-action';
    await seedSession(sessionId);

    const { setKeyboardStatus: statusA, config: configA } = makeConfig();
    const { setKeyboardStatus: statusB, config: configB } = makeConfig();

    let abortRejectA!: (err: Error) => void;
    mockStreamAgentText.mockImplementationOnce(
      ({ signal }: StreamAgentTextOptions) =>
        new Promise<string>((_resolve, reject) => {
          abortRejectA = reject;
          signal?.addEventListener('abort', () => {
            const err = new Error('The operation was aborted');
            err.name = 'AbortError';
            reject(err);
          });
        }),
    );
    mockStreamAgentText.mockResolvedValueOnce('Result B');

    const now = Date.now();
    const actionA = makeAction({ sessionId, requestId: makeRequestId(now, 'a') });
    const actionB = makeAction({ sessionId, requestId: makeRequestId(now + 5, 'b') });

    const pA = handleAgentAction(actionA, configA);
    const pB = handleAgentAction(actionB, configB);

    if (abortRejectA) {
      const err = new Error('The operation was aborted');
      err.name = 'AbortError';
      abortRejectA(err);
    }
    await Promise.all([pA, pB]);

    expect(statusA).not.toHaveBeenCalledWith('agent_error', expect.anything());
    expect(statusA).not.toHaveBeenCalledWith('agent_ready', undefined);

    expect(statusB).toHaveBeenCalledWith('agent_ready', undefined);
    expect(mockWriteKeyboardAgentResult).toHaveBeenCalledTimes(1);
    expect(mockWriteKeyboardAgentResult).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: actionB.requestId }),
    );
  });

  it('older action arriving while a newer one is in flight is rejected (no stream, no write)', async () => {
    const sessionId = 'session-supersede-older';
    await seedSession(sessionId);

    const now = Date.now();
    mockStreamAgentText.mockResolvedValueOnce('newer result');
    await handleAgentAction(
      makeAction({ sessionId, requestId: makeRequestId(now + 100, 'newer') }),
      makeConfig().config,
    );
    jest.clearAllMocks();

    const { setKeyboardStatus, config } = makeConfig();
    await handleAgentAction(
      makeAction({ sessionId, requestId: makeRequestId(now, 'older') }),
      config,
    );

    expect(mockStreamAgentText).not.toHaveBeenCalled();
    expect(mockWriteKeyboardAgentResult).not.toHaveBeenCalled();
    expect(setKeyboardStatus).not.toHaveBeenCalledWith('agent_ready', undefined);
  });

  it('a regenerate hammered during an in-flight follow-up yields a single new version', async () => {
    const sessionId = 'session-supersede-followup';
    await seedSession(sessionId, 'base');

    const followJob = makeComposeJob({
      sessionId,
      jobId: makeRequestId(Date.now() + 1, 'follow'),
      kind: 'follow_up',
    });

    let abortRejectFollow!: (err: Error) => void;
    mockStreamAgentText.mockImplementationOnce(
      ({ signal }: StreamAgentTextOptions) =>
        new Promise<string>((_resolve, reject) => {
          abortRejectFollow = reject;
          signal?.addEventListener('abort', () => {
            const err = new Error('The operation was aborted');
            err.name = 'AbortError';
            reject(err);
          });
        }),
    );
    mockStreamAgentText.mockResolvedValueOnce('regen wins');
    mockReadKeyboardAgentJob.mockReturnValue(
      makeComposeJob({
        sessionId,
        jobId: makeRequestId(Date.now() + 2, 'regen'),
        kind: 'compose',
      }),
    );

    const pFollow = generateForJob(followJob, 'make it formal', makeConfig().config);
    const regenAction = makeAction({
      sessionId,
      requestId: makeRequestId(Date.now() + 2, 'regen'),
    });
    const pRegen = handleAgentAction(regenAction, makeConfig().config);

    if (abortRejectFollow) {
      const err = new Error('The operation was aborted');
      err.name = 'AbortError';
      abortRejectFollow(err);
    }
    await Promise.all([pFollow, pRegen]);

    expect(mockWriteKeyboardAgentResult).toHaveBeenCalledTimes(1);
    const session = getActiveSession(sessionId);
    expect(session?.versions).toEqual(['base', 'regen wins']);
  });
});

// ---------------------------------------------------------------------------
// Sliding window: system + last MAX_WINDOW_TURNS turns, pairs intact
// ---------------------------------------------------------------------------

describe('sliding window', () => {
  it('sends system + last MAX_WINDOW_TURNS messages, starting on a user turn', async () => {
    const sessionId = 'session-window';
    const composeJob = makeComposeJob({ sessionId, jobId: `${Date.now()}-c` });
    mockStreamAgentText.mockResolvedValueOnce('a0');
    mockReadKeyboardAgentJob.mockReturnValueOnce(composeJob);
    await generateForJob(composeJob, 'u0', makeConfig().config);

    for (let i = 1; i <= 5; i++) {
      const followJob = makeComposeJob({
        sessionId,
        jobId: `${Date.now()}-f${i}`,
        kind: 'follow_up',
      });
      mockStreamAgentText.mockResolvedValueOnce(`a${i}`);
      mockReadKeyboardAgentJob.mockReturnValueOnce(followJob);
      await generateForJob(followJob, `u${i}`, makeConfig().config);
    }

    jest.clearAllMocks();
    mockLoadAgentSessions.mockReturnValue(null);
    const action = makeAction({ sessionId, requestId: makeRequestId(Date.now() + 99, 'w') });
    mockStreamAgentText.mockResolvedValue('final');
    await handleAgentAction(action, makeConfig().config);

    const sent = mockStreamAgentText.mock.calls[0][0].messages;
    expect(sent.length).toBeLessThanOrEqual(MAX_WINDOW_TURNS);
    expect(sent[0].role).toBe('user');
    expect(sent[sent.length - 1].role).toBe('user');
    expect(mockStreamAgentText.mock.calls[0][0].systemPrompt).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Persistence: sessions saved on write; rehydrated lazily so regenerate works
// after an app kill.
// ---------------------------------------------------------------------------

describe('session persistence', () => {
  it('persists sessions after a successful generation', async () => {
    const sessionId = 'session-persist';
    const job = makeComposeJob({ sessionId, jobId: 'job-persist' });
    mockStreamAgentText.mockResolvedValue('persisted draft');
    mockReadKeyboardAgentJob.mockReturnValue(job);

    await generateForJob(job, 'write it', makeConfig().config);

    expect(mockSaveAgentSessions).toHaveBeenCalled();
    const saved = mockSaveAgentSessions.mock.calls.at(-1)?.[0] as PersistedAgentSession[];
    const persisted = saved.find((s) => s.sessionId === sessionId);
    expect(persisted).toBeDefined();
    expect(persisted?.versions).toEqual(['persisted draft']);
    expect(persisted).not.toHaveProperty('inFlightController');
  });

  it('rehydrates a persisted session so regenerate works after a cold start', async () => {
    const sessionId = 'session-cold';
    const now = Date.now();
    clearAllSessions();
    mockLoadAgentSessions.mockReturnValue([
      {
        sessionId,
        messages: [
          { role: 'user', content: 'original request' },
          { role: 'assistant', content: 'original draft' },
        ],
        versions: ['original draft'],
        lastActivityAtMs: now,
        latestRequestId: makeRequestId(now, 'seed'),
      },
    ]);

    const action = makeAction({ sessionId, requestId: makeRequestId(now + 50, 'cold') });
    mockStreamAgentText.mockResolvedValue('regenerated after cold start');
    const { setKeyboardStatus, config } = makeConfig();

    await handleAgentAction(action, config);

    expect(mockStreamAgentText).toHaveBeenCalledTimes(1);
    const written = mockWriteKeyboardAgentResult.mock.calls[0][0];
    expect(written.versions).toEqual(['original draft', 'regenerated after cold start']);
    expect(setKeyboardStatus).toHaveBeenLastCalledWith('agent_ready', undefined);
  });

  it('yields agent_ready even when saveAgentSessions throws (quota exceeded)', async () => {
    const sessionId = 'session-quota';
    const job = makeComposeJob({ sessionId, jobId: 'job-quota' });
    mockStreamAgentText.mockResolvedValue('quota draft');
    mockReadKeyboardAgentJob.mockReturnValue(job);
    mockSaveAgentSessions.mockImplementationOnce(() => {
      throw new Error('QuotaExceededError');
    });

    const { setKeyboardStatus, config } = makeConfig();
    await generateForJob(job, 'write it', config);

    expect(mockWriteKeyboardAgentResult).toHaveBeenCalledTimes(1);
    expect(setKeyboardStatus).toHaveBeenLastCalledWith('agent_ready', undefined);
    expect(setKeyboardStatus).not.toHaveBeenCalledWith('agent_error', expect.anything());
  });

  it('does not rehydrate an expired persisted session (TTL pruned on access)', async () => {
    const sessionId = 'session-cold-expired';
    clearAllSessions();
    mockLoadAgentSessions.mockReturnValue([
      {
        sessionId,
        messages: [{ role: 'user', content: 'old' }],
        versions: ['old'],
        lastActivityAtMs: Date.now() - 16 * 60 * 1000,
        latestRequestId: null,
      },
    ]);

    const { setKeyboardStatus, config } = makeConfig();
    await handleAgentAction(makeAction({ sessionId }), config);

    expect(mockStreamAgentText).not.toHaveBeenCalled();
    expect(setKeyboardStatus).toHaveBeenCalledWith('agent_error', 'session_expired');
  });
});

// ---------------------------------------------------------------------------
// Pre-write cancel checkpoint (finding #3, JS side): X on the "Writing" pill
// raises the shared cancel flag; the commit drops the result before writing so
// the keyboard never shows a card for a cancelled generation.
// ---------------------------------------------------------------------------

describe('pre-write cancel checkpoint', () => {
  it('generateForJob drops the result (no write) when the cancel flag is set', async () => {
    const job = makeComposeJob({ sessionId: 'session-cancel', jobId: 'job-cancel' });
    mockStreamAgentText.mockResolvedValue('cancelled draft');
    mockReadKeyboardAgentJob.mockReturnValue(job);
    mockIsKeyboardAgentCancelled.mockReturnValue(true);

    const { setKeyboardStatus, config } = makeConfig();
    await generateForJob(job, 'write it', config);

    expect(mockStreamAgentText).toHaveBeenCalledTimes(1);
    expect(mockWriteKeyboardAgentResult).not.toHaveBeenCalled();
    expect(setKeyboardStatus).not.toHaveBeenCalledWith('agent_ready', undefined);
  });

  it('handleAgentAction (regenerate) drops the result when the cancel flag is set', async () => {
    const sessionId = 'session-cancel-regen';
    const seedJob = makeComposeJob({ sessionId, jobId: 'job-seed' });
    mockStreamAgentText.mockResolvedValueOnce('seed draft');
    mockReadKeyboardAgentJob.mockReturnValue(seedJob);
    await generateForJob(seedJob, 'write it', makeConfig().config);
    mockWriteKeyboardAgentResult.mockClear();

    mockStreamAgentText.mockResolvedValueOnce('regenerated draft');
    mockIsKeyboardAgentCancelled.mockReturnValue(true);

    const { setKeyboardStatus, config } = makeConfig();
    await handleAgentAction(makeAction({ sessionId }), config);

    expect(mockWriteKeyboardAgentResult).not.toHaveBeenCalled();
    expect(setKeyboardStatus).not.toHaveBeenCalledWith('agent_ready', undefined);
  });
});

// ---------------------------------------------------------------------------
// clearAllSessions wiring (finding #6): sign-out / delete-account must drop
// persisted sessions too, not just the in-memory map.
// ---------------------------------------------------------------------------

describe('clearAllSessions', () => {
  it('clears persisted sessions via StorageService', () => {
    mockClearAgentSessions.mockClear();
    clearAllSessions();
    expect(mockClearAgentSessions).toHaveBeenCalledTimes(1);
  });

  it('drops the in-memory session so a later regenerate sees session_expired', async () => {
    const sessionId = 'session-wipe';
    const job = makeComposeJob({ sessionId, jobId: 'job-wipe' });
    mockStreamAgentText.mockResolvedValue('draft');
    mockReadKeyboardAgentJob.mockReturnValue(job);
    await generateForJob(job, 'write it', makeConfig().config);
    expect(getActiveSession(sessionId)).not.toBeNull();

    clearAllSessions();
    mockLoadAgentSessions.mockReturnValue(null);

    const { setKeyboardStatus, config } = makeConfig();
    await handleAgentAction(makeAction({ sessionId }), config);
    expect(setKeyboardStatus).toHaveBeenCalledWith('agent_error', 'session_expired');
  });
});

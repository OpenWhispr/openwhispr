import {
  startKeyboardAgentSync,
  snapshotKeyboardAgentRequest,
  readKeyboardAgentJob,
  clearKeyboardAgentJob,
  writeKeyboardAgentResult,
  consumeKeyboardAgentAction,
  isKeyboardAgentCancelled,
} from '@/lib/keyboardAgentSync';
import type { KeyboardAgentJob, KeyboardAgentResult } from '@/lib/keyboardAgentSync';
import { useConfigStore } from '@/store/useConfigStore';
import { useProcessingModeStore } from '@/store/useProcessingModeStore';

const store: Record<string, string> = {};

jest.mock('../../../modules/app-group-storage/src', () => ({
  AppGroupStorage: {
    getItem: (key: string) => store[key] ?? null,
    setItem: (key: string, value: string) => {
      store[key] = value;
      return true;
    },
    removeItem: (key: string) => {
      delete store[key];
      return true;
    },
  },
  APP_GROUP_KEYS: {
    KEYBOARD_AGENT_ENABLED: 'keyboard_agent_enabled',
    KEYBOARD_AGENT_APPLICABLE: 'keyboard_agent_applicable',
    KEYBOARD_AGENT_NAME: 'keyboard_agent_name',
    KEYBOARD_AGENT_SHARE_CONTEXT: 'keyboard_agent_share_context',
    KEYBOARD_AGENT_REQUEST: 'keyboard_agent_request',
    KEYBOARD_AGENT_JOB: 'keyboard_agent_job',
    KEYBOARD_AGENT_RESULT: 'keyboard_agent_result',
    KEYBOARD_AGENT_ACTION: 'keyboard_agent_action',
    KEYBOARD_AGENT_ACTION_AT_MS: 'keyboard_agent_action_at_ms',
    KEYBOARD_CANCEL_REQUESTED: 'keyboard_cancel_requested',
  },
}));

jest.mock('react-native', () => ({
  AppState: { addEventListener: () => ({ remove: () => {} }) },
}));

jest.mock('@/services/storage/StorageService', () => ({
  StorageService: { saveConfig: jest.fn(async () => {}) },
}));

jest.mock('@/lib/uuid', () => ({
  randomUUID: jest.fn(() => 'test-uuid-1234'),
}));

beforeEach(() => {
  for (const key of Object.keys(store)) delete store[key];
  jest.clearAllMocks();
});

// ─── Mirror keys ───────────────────────────────────────────────────────────────

describe('startKeyboardAgentSync mirror keys', () => {
  it('writes enabled=1 when dictationAgentEnabled is true', () => {
    useConfigStore.setState({
      config: { defaultMode: 'cloud', dictationAgentEnabled: true } as any,
    });
    useProcessingModeStore.setState({ activeMode: 'cloud' });

    const stop = startKeyboardAgentSync();
    expect(store.keyboard_agent_enabled).toBe('1');
    stop();
  });

  it('writes enabled=0 when dictationAgentEnabled is false', () => {
    useConfigStore.setState({
      config: { defaultMode: 'cloud', dictationAgentEnabled: false } as any,
    });
    useProcessingModeStore.setState({ activeMode: 'cloud' });

    const stop = startKeyboardAgentSync();
    expect(store.keyboard_agent_enabled).toBe('0');
    stop();
  });

  it('writes applicable=1 in cloud mode with agent enabled', () => {
    useConfigStore.setState({
      config: { defaultMode: 'cloud', dictationAgentEnabled: true } as any,
    });
    useProcessingModeStore.setState({ activeMode: 'cloud' });

    const stop = startKeyboardAgentSync();
    expect(store.keyboard_agent_applicable).toBe('1');
    stop();
  });

  it('writes applicable=0 in private mode even when agent enabled', () => {
    useConfigStore.setState({
      config: { defaultMode: 'cloud', dictationAgentEnabled: true } as any,
    });
    useProcessingModeStore.setState({ activeMode: 'private' });

    const stop = startKeyboardAgentSync();
    expect(store.keyboard_agent_applicable).toBe('0');
    stop();
  });

  it('writes applicable=0 in cloud mode when agent disabled', () => {
    useConfigStore.setState({
      config: { defaultMode: 'cloud', dictationAgentEnabled: false } as any,
    });
    useProcessingModeStore.setState({ activeMode: 'cloud' });

    const stop = startKeyboardAgentSync();
    expect(store.keyboard_agent_applicable).toBe('0');
    stop();
  });

  it('writes the agent name from config', () => {
    useConfigStore.setState({
      config: { defaultMode: 'cloud', dictationAgentName: 'Aria' } as any,
    });
    useProcessingModeStore.setState({ activeMode: 'cloud' });

    const stop = startKeyboardAgentSync();
    expect(store.keyboard_agent_name).toBe('Aria');
    stop();
  });

  it('writes default name when dictationAgentName is unset', () => {
    useConfigStore.setState({
      config: { defaultMode: 'cloud' } as any,
    });
    useProcessingModeStore.setState({ activeMode: 'cloud' });

    const stop = startKeyboardAgentSync();
    expect(store.keyboard_agent_name).toBe('OpenWhispr');
    stop();
  });

  it('writes share_context=1 when dictationAgentShareContext is true', () => {
    useConfigStore.setState({
      config: { defaultMode: 'cloud', dictationAgentShareContext: true } as any,
    });
    useProcessingModeStore.setState({ activeMode: 'cloud' });

    const stop = startKeyboardAgentSync();
    expect(store.keyboard_agent_share_context).toBe('1');
    stop();
  });

  it('writes share_context=0 when dictationAgentShareContext is false/unset', () => {
    useConfigStore.setState({
      config: { defaultMode: 'cloud' } as any,
    });
    useProcessingModeStore.setState({ activeMode: 'cloud' });

    const stop = startKeyboardAgentSync();
    expect(store.keyboard_agent_share_context).toBe('0');
    stop();
  });

  it('updates applicable when mode changes', () => {
    useConfigStore.setState({
      config: { defaultMode: 'cloud', dictationAgentEnabled: true } as any,
    });
    useProcessingModeStore.setState({ activeMode: 'private' });

    const stop = startKeyboardAgentSync();
    expect(store.keyboard_agent_applicable).toBe('0');

    useProcessingModeStore.getState().setActiveMode('cloud', true);
    expect(store.keyboard_agent_applicable).toBe('1');
    stop();
  });
});

// ─── Request consumption ───────────────────────────────────────────────────────

describe('snapshotKeyboardAgentRequest', () => {
  it('returns null when no request exists', () => {
    const result = snapshotKeyboardAgentRequest('job-1');
    expect(result).toBeNull();
  });

  it('returns null and clears key for invalid JSON', () => {
    store.keyboard_agent_request = 'not-valid-json{{{';
    const result = snapshotKeyboardAgentRequest('job-1');
    expect(result).toBeNull();
    expect(store.keyboard_agent_request).toBeUndefined();
  });

  it('returns null and clears a stale request (>15s old)', () => {
    const oldMs = Date.now() - 16_000;
    store.keyboard_agent_request = JSON.stringify({
      kind: 'compose',
      requestedAtMs: oldMs,
    });

    const result = snapshotKeyboardAgentRequest('job-1');
    expect(result).toBeNull();
    expect(store.keyboard_agent_request).toBeUndefined();
  });

  it('consumes a fresh compose request: new sessionId, job written, request cleared', () => {
    const { randomUUID } = require('@/lib/uuid');
    (randomUUID as jest.Mock).mockReturnValue('new-session-id');

    store.keyboard_agent_request = JSON.stringify({
      kind: 'compose',
      requestedAtMs: Date.now() - 1_000,
      contextBefore: 'hello',
    });

    const job = snapshotKeyboardAgentRequest('job-42') as KeyboardAgentJob;

    expect(job).not.toBeNull();
    expect(job.jobId).toBe('job-42');
    expect(job.sessionId).toBe('new-session-id');
    expect(job.kind).toBe('compose');
    expect(job.contextBefore).toBe('hello');
    expect(store.keyboard_agent_request).toBeUndefined();

    const stored = JSON.parse(store.keyboard_agent_job) as KeyboardAgentJob;
    expect(stored.jobId).toBe('job-42');
    expect(stored.sessionId).toBe('new-session-id');
  });

  it('follow_up reuses the existing sessionId from the request', () => {
    store.keyboard_agent_request = JSON.stringify({
      kind: 'follow_up',
      sessionId: 'existing-session',
      requestedAtMs: Date.now() - 500,
      selectedText: 'some text',
    });

    const job = snapshotKeyboardAgentRequest('job-99') as KeyboardAgentJob;

    expect(job).not.toBeNull();
    expect(job.sessionId).toBe('existing-session');
    expect(job.kind).toBe('follow_up');
    expect(job.selectedText).toBe('some text');
  });

  it('follow_up without sessionId falls back to compose semantics (new sessionId + kind)', () => {
    const { randomUUID } = require('@/lib/uuid');
    (randomUUID as jest.Mock).mockReturnValue('fallback-session');

    store.keyboard_agent_request = JSON.stringify({
      kind: 'follow_up',
      requestedAtMs: Date.now() - 500,
    });

    const job = snapshotKeyboardAgentRequest('job-100') as KeyboardAgentJob;

    expect(job).not.toBeNull();
    expect(job.sessionId).toBe('fallback-session');
    expect(job.kind).toBe('compose');
  });

  it('snapshot carries tone from config store', () => {
    useConfigStore.setState({
      config: { defaultMode: 'cloud', keyboardTone: 'formal' } as any,
    });

    store.keyboard_agent_request = JSON.stringify({
      kind: 'compose',
      requestedAtMs: Date.now() - 500,
    });

    const job = snapshotKeyboardAgentRequest('job-t') as KeyboardAgentJob;
    expect(job.tone).toBe('formal');
  });

  it('is idempotent per jobId: second call returns same job, request consumed once', () => {
    const { randomUUID } = require('@/lib/uuid');
    (randomUUID as jest.Mock).mockReturnValue('idem-session');

    store.keyboard_agent_request = JSON.stringify({
      kind: 'compose',
      requestedAtMs: Date.now() - 500,
    });

    const first = snapshotKeyboardAgentRequest('job-idem') as KeyboardAgentJob;
    expect(store.keyboard_agent_request).toBeUndefined();

    const second = snapshotKeyboardAgentRequest('job-idem') as KeyboardAgentJob;
    expect(second).not.toBeNull();
    expect(second.jobId).toBe(first.jobId);
    expect(second.sessionId).toBe(first.sessionId);
    // randomUUID called exactly once — second call returns the already-written job.
    expect(randomUUID).toHaveBeenCalledTimes(1);
  });
});

// ─── readKeyboardAgentJob ──────────────────────────────────────────────────────

describe('readKeyboardAgentJob', () => {
  it('returns null when nothing is stored', () => {
    expect(readKeyboardAgentJob('job-1')).toBeNull();
  });

  it('returns the job when jobId matches', () => {
    const job: KeyboardAgentJob = {
      jobId: 'job-55',
      sessionId: 'sess-1',
      kind: 'compose',
      requestedAtMs: Date.now(),
      tone: 'default',
    };
    store.keyboard_agent_job = JSON.stringify(job);

    const result = readKeyboardAgentJob('job-55');
    expect(result).not.toBeNull();
    expect(result?.jobId).toBe('job-55');
  });

  it('returns null when jobId mismatches', () => {
    const job: KeyboardAgentJob = {
      jobId: 'job-55',
      sessionId: 'sess-1',
      kind: 'compose',
      requestedAtMs: Date.now(),
      tone: 'default',
    };
    store.keyboard_agent_job = JSON.stringify(job);

    expect(readKeyboardAgentJob('job-99')).toBeNull();
  });

  it('returns null on invalid JSON', () => {
    store.keyboard_agent_job = 'bad json{{{';
    expect(readKeyboardAgentJob('job-1')).toBeNull();
  });
});

// ─── clearKeyboardAgentJob ─────────────────────────────────────────────────────

describe('clearKeyboardAgentJob', () => {
  it('clears only the job key, not the result key', () => {
    store.keyboard_agent_job = JSON.stringify({ jobId: 'j1' });
    store.keyboard_agent_result = JSON.stringify({ versions: ['v1'] });

    clearKeyboardAgentJob();

    expect(store.keyboard_agent_job).toBeUndefined();
    expect(store.keyboard_agent_result).toBe(JSON.stringify({ versions: ['v1'] }));
  });
});

// ─── writeKeyboardAgentResult ─────────────────────────────────────────────────

describe('writeKeyboardAgentResult', () => {
  it('writes a result with versions and stamps updatedAtMs', () => {
    const before = Date.now();
    writeKeyboardAgentResult({
      sessionId: 'sess-1',
      jobId: 'job-1',
      versions: ['Hello world'],
      activeIndex: 0,
    });

    const stored = JSON.parse(store.keyboard_agent_result) as KeyboardAgentResult;
    expect(stored.sessionId).toBe('sess-1');
    expect(stored.jobId).toBe('job-1');
    expect(stored.versions).toEqual(['Hello world']);
    expect(stored.activeIndex).toBe(0);
    expect(stored.updatedAtMs).toBeGreaterThanOrEqual(before);
  });

  it('caps versions at 5, keeping the newest, and adjusts activeIndex', () => {
    // 7 versions, activeIndex 6 (newest). After cap: 5 versions, activeIndex
    // should point at the same logical entry (v7, the last one → index 4).
    writeKeyboardAgentResult({
      sessionId: 's',
      jobId: 'j',
      versions: ['v1', 'v2', 'v3', 'v4', 'v5', 'v6', 'v7'],
      activeIndex: 6,
    });

    const stored = JSON.parse(store.keyboard_agent_result) as KeyboardAgentResult;
    expect(stored.versions).toHaveLength(5);
    expect(stored.versions).toEqual(['v3', 'v4', 'v5', 'v6', 'v7']);
    expect(stored.activeIndex).toBe(4);
    expect(stored.activeIndex).toBeLessThanOrEqual(stored.versions.length - 1);
  });

  it('trims oversized version strings', () => {
    const longVersion = 'x'.repeat(10_000);
    writeKeyboardAgentResult({
      sessionId: 's',
      jobId: 'j',
      versions: [longVersion],
      activeIndex: 0,
    });

    const stored = JSON.parse(store.keyboard_agent_result) as KeyboardAgentResult;
    expect(stored.versions[0].length).toBeLessThan(10_000);
  });

  it('round-trips through JSON correctly', () => {
    const input = {
      sessionId: 'sess-rt',
      jobId: 'job-rt',
      versions: ['First draft', 'Revised draft'],
      activeIndex: 1,
    };
    writeKeyboardAgentResult(input);

    const stored = JSON.parse(store.keyboard_agent_result) as KeyboardAgentResult;
    expect(stored.sessionId).toBe('sess-rt');
    expect(stored.versions[0]).toBe('First draft');
    expect(stored.versions[1]).toBe('Revised draft');
    expect(stored.activeIndex).toBe(1);
  });

  it('safety-trim loop keeps activeIndex in bounds', () => {
    // Create a payload that exceeds MAX_PAYLOAD_CHARS (8000) so the trim loop fires.
    // Five versions each ~2000 chars → total payload ~10 KB → triggers trim.
    const bigVersion = 'y'.repeat(1_900);
    writeKeyboardAgentResult({
      sessionId: 's',
      jobId: 'j',
      versions: [bigVersion, bigVersion, bigVersion, bigVersion, bigVersion],
      activeIndex: 4,
    });

    const stored = JSON.parse(store.keyboard_agent_result) as KeyboardAgentResult;
    // Some versions were trimmed from the front; activeIndex must be in bounds.
    expect(stored.activeIndex).toBeGreaterThanOrEqual(0);
    expect(stored.activeIndex).toBeLessThanOrEqual(stored.versions.length - 1);
  });

  it('activeIndex is clamped to 0 when all leading versions are dropped', () => {
    // activeIndex pointing at the first version — should clamp to 0 after trim.
    writeKeyboardAgentResult({
      sessionId: 's',
      jobId: 'j',
      versions: ['v1', 'v2', 'v3', 'v4', 'v5', 'v6', 'v7'],
      activeIndex: 0,
    });

    const stored = JSON.parse(store.keyboard_agent_result) as KeyboardAgentResult;
    expect(stored.activeIndex).toBeGreaterThanOrEqual(0);
    expect(stored.activeIndex).toBeLessThanOrEqual(stored.versions.length - 1);
  });
});

// ─── consumeKeyboardAgentAction ────────────────────────────────────────────────

describe('consumeKeyboardAgentAction', () => {
  it('returns null when no action is stored', () => {
    expect(consumeKeyboardAgentAction()).toBeNull();
  });

  it('returns a fresh action and clears both keys', () => {
    const atMs = Date.now() - 1_000;
    store.keyboard_agent_action = JSON.stringify({
      type: 'regenerate',
      sessionId: 'sess-1',
      requestId: `${atMs}-uuid`,
      atMs,
    });
    store.keyboard_agent_action_at_ms = String(atMs);

    const action = consumeKeyboardAgentAction();
    expect(action).not.toBeNull();
    expect(action?.type).toBe('regenerate');
    expect(action?.sessionId).toBe('sess-1');
    expect(action?.requestId).toBe(`${atMs}-uuid`);
    expect(store.keyboard_agent_action).toBeUndefined();
    expect(store.keyboard_agent_action_at_ms).toBeUndefined();
  });

  it('drops and clears a stale action (>15s per the at-ms twin)', () => {
    const oldMs = Date.now() - 16_000;
    store.keyboard_agent_action = JSON.stringify({
      type: 'regenerate',
      sessionId: 'sess-1',
      requestId: `${oldMs}-uuid`,
      atMs: oldMs,
    });
    store.keyboard_agent_action_at_ms = String(oldMs);

    expect(consumeKeyboardAgentAction()).toBeNull();
    expect(store.keyboard_agent_action).toBeUndefined();
    expect(store.keyboard_agent_action_at_ms).toBeUndefined();
  });

  it('drops and clears an invalid JSON action', () => {
    store.keyboard_agent_action = 'not-json{{{';
    store.keyboard_agent_action_at_ms = String(Date.now());

    expect(consumeKeyboardAgentAction()).toBeNull();
    expect(store.keyboard_agent_action).toBeUndefined();
    expect(store.keyboard_agent_action_at_ms).toBeUndefined();
  });

  it('returns null and clears for a malformed action missing sessionId/requestId', () => {
    const atMs = Date.now();
    store.keyboard_agent_action = JSON.stringify({ type: 'regenerate', atMs });
    store.keyboard_agent_action_at_ms = String(atMs);

    expect(consumeKeyboardAgentAction()).toBeNull();
    expect(store.keyboard_agent_action).toBeUndefined();
  });
});

// ─── isKeyboardAgentCancelled ──────────────────────────────────────────────────

describe('isKeyboardAgentCancelled', () => {
  it('returns false when the cancel flag is absent', () => {
    expect(isKeyboardAgentCancelled()).toBe(false);
  });

  it('returns true only when the cancel flag equals "1"', () => {
    store.keyboard_cancel_requested = '1';
    expect(isKeyboardAgentCancelled()).toBe(true);
  });

  it('returns false for any non-"1" value and does not clear the flag', () => {
    store.keyboard_cancel_requested = '0';
    expect(isKeyboardAgentCancelled()).toBe(false);
    expect(store.keyboard_cancel_requested).toBe('0');
  });
});

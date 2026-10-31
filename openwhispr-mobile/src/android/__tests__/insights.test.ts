const memory = new Map<string, string>();
let mockUser: { id: string; isAnonymous?: boolean } | null = { id: 'a' };
let mockSessionCookie: string | null = 'synthetic-session-a';
const mockAuthListeners = new Set<() => void>();
const mockConfigListeners = new Set<() => void>();
let mockSaveError: string | null = null;
let mockConfig = { androidHistoryDays: 30, insightsSyncEnabled: false };
jest.mock('@/store/useAuthStore', () => ({
  useAuthStore: {
    getState: () => ({ user: mockUser, sessionCookie: mockSessionCookie }),
    subscribe: (listener: () => void) => {
      mockAuthListeners.add(listener);
      return () => mockAuthListeners.delete(listener);
    },
  },
}));
jest.mock('@/store/useConfigStore', () => ({
  useConfigStore: {
    getState: () => ({
      config: mockConfig,
      error: mockSaveError,
      updateConfig: async (change: object) => {
        if (!mockSaveError) {
          Object.assign(mockConfig, change);
          [...mockConfigListeners].forEach((listener) => listener());
        }
      },
    }),
    subscribe: (listener: () => void) => {
      mockConfigListeners.add(listener);
      return () => mockConfigListeners.delete(listener);
    },
  },
}));
jest.mock('@/lib/apiClient', () => ({
  api: { post: jest.fn(), get: jest.fn() },
  ApiError: class extends Error {
    status: number;
    code?: string;
    constructor(message: string, status: number, code?: string) {
      super(message);
      this.status = status;
      this.code = code;
    }
  },
}));
import { api, ApiError } from '@/lib/apiClient';
import {
  setInsightsSyncConsent,
  eraseAccountInsights,
  countSpokenWords,
  insightsScope,
  recordInsight,
  refreshInsights,
  useInsights,
  type InsightEvent,
} from '../insights';
const event: InsightEvent = {
  event_id: 'one',
  occurred_at: '2026-10-15T12:00:00Z',
  local_date: '2026-10-15',
  word_count: 4,
  spoken_duration_ms: 2000,
  mode: 'local',
  provider: 'local',
  model: null,
  counter_version: 2,
};
beforeEach(async () => {
  memory.clear();
  mockSaveError = null;
  jest.clearAllMocks();
  mockUser = { id: 'a' };
  mockSessionCookie = 'synthetic-session-a';
  mockConfig = { androidHistoryDays: 30, insightsSyncEnabled: false };
  Object.defineProperty(global, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => memory.get(key) ?? null,
      setItem: (key: string, value: string) => memory.set(key, value),
      removeItem: (key: string) => memory.delete(key),
    },
  });
  jest.mocked(api.post).mockResolvedValue({ accepted: ['one'], rejected: [] });
  jest.mocked(api.get).mockResolvedValue({ totalWords: 10, totalDictations: 3 });
  // Explicit, successfully persisted opt-in resets the process-local consent gate.
  mockUser = null;
  await setInsightsSyncConsent(true);
  mockUser = { id: 'a' };
  mockConfig.insightsSyncEnabled = false;
});
it('deduplicates persisted events and preserves counts when retention changes', async () => {
  recordInsight(insightsScope(), event);
  recordInsight(insightsScope(), event);
  mockConfig.androidHistoryDays = 7;
  await refreshInsights();
  expect(useInsights.getState().ledger.events).toEqual([event]);
  expect(api.post).not.toHaveBeenCalled();
  mockConfig.androidHistoryDays = 0;
  recordInsight(insightsScope(), { ...event, event_id: 'two' });
  await refreshInsights();
  expect(useInsights.getState().ledger.events).toHaveLength(1);
});
it('uploads content-free events only after explicit consent and never adds local counts to account totals', async () => {
  recordInsight(insightsScope(), event);
  mockConfig.insightsSyncEnabled = true;
  await refreshInsights();
  await refreshInsights();
  expect(api.post).toHaveBeenCalledTimes(1);
  expect(api.post).toHaveBeenCalledWith(
    '/api/analytics/events/batch',
    { events: [event] },
    expect.objectContaining({ headers: { 'x-openwhispr-source': 'mobile' } }),
  );
  expect(useInsights.getState().ledger.summary?.totalWords).toBe(10);
});
it('does not move signed-out or other account events into a new account', async () => {
  mockUser = null;
  recordInsight(insightsScope(), event);
  mockUser = { id: 'b' };
  mockConfig.insightsSyncEnabled = true;
  await refreshInsights();
  expect(api.post).not.toHaveBeenCalled();
  expect(useInsights.getState().ledger.events).toEqual([]);
});
it('keeps unacknowledged events for retry and stops permanently rejected events', async () => {
  recordInsight(insightsScope(), event);
  recordInsight(insightsScope(), { ...event, event_id: 'two' });
  mockConfig.insightsSyncEnabled = true;
  jest.mocked(api.post).mockResolvedValueOnce({ accepted: ['one'], rejected: ['one'] });
  await refreshInsights();
  await refreshInsights();
  expect(jest.mocked(api.post).mock.calls[1][1]).toEqual({
    events: [{ ...event, event_id: 'two' }],
  });
});
it('ignores a response when consent is revoked in flight', async () => {
  recordInsight(insightsScope(), event);
  mockConfig.insightsSyncEnabled = true;
  let resolve!: (value: unknown) => void;
  jest.mocked(api.post).mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const pending = refreshInsights();
  mockConfig.insightsSyncEnabled = false;
  resolve({ accepted: ['one'], rejected: [] });
  await pending;
  expect(api.get).not.toHaveBeenCalled();
  expect(useInsights.getState().ledger.acknowledged).toEqual([]);
});
it('reports an organization policy block and preserves queued events', async () => {
  recordInsight(insightsScope(), event);
  mockConfig.insightsSyncEnabled = true;
  jest
    .mocked(api.post)
    .mockRejectedValue(new ApiError('blocked', 403, 'POLICY_CLOUD_BACKUP_BLOCKED'));
  await refreshInsights();
  expect(useInsights.getState().status).toBe('blocked');
  expect(useInsights.getState().ledger.acknowledged).toEqual([]);
});
it('rejects malformed summary totals without replacing a previous snapshot', async () => {
  mockConfig.insightsSyncEnabled = true;
  await refreshInsights();
  jest.mocked(api.get).mockResolvedValue({ totalWords: -10, totalDictations: 3 });
  await refreshInsights();
  expect(useInsights.getState().ledger.summary?.totalWords).toBe(10);
  expect(useInsights.getState().status).toBe('offline');
});
it('matches desktop counting including whitespace and CJK segmentation', () => {
  expect(countSpokenWords('  one\n two  three ')).toBe(3);
  expect(countSpokenWords('')).toBe(0);
  const text = '你好世界';
  const expected = Array.from(
    new Intl.Segmenter('und', { granularity: 'word' }).segment(text),
  ).filter((part) => part.isWordLike).length;
  expect(countSpokenWords(text)).toBe(expected);
});

it('fails closed when persisting opt-out fails', async () => {
  recordInsight(insightsScope(), event);
  mockConfig.insightsSyncEnabled = true;
  mockSaveError = 'disk unavailable';
  await expect(setInsightsSyncConsent(false)).rejects.toThrow('disk unavailable');
  await refreshInsights();
  expect(api.post).not.toHaveBeenCalled();
});
it('does not recreate a deleted account ledger from a late capture', async () => {
  recordInsight(insightsScope(), event);
  eraseAccountInsights('a');
  recordInsight('account:a', { ...event, event_id: 'late' });
  await refreshInsights();
  expect(useInsights.getState().ledger.events).toEqual([]);
  expect(api.post).not.toHaveBeenCalled();
});
it('flushes an event added while the previous batch is in flight', async () => {
  recordInsight(insightsScope(), event);
  mockConfig.insightsSyncEnabled = true;
  let resolve!: (value: unknown) => void;
  jest.mocked(api.post).mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const first = refreshInsights();
  recordInsight(insightsScope(), { ...event, event_id: 'two' });
  resolve({ accepted: ['one'], rejected: [] });
  await first;
  await refreshInsights();
  expect(jest.mocked(api.post).mock.calls[1][1]).toEqual({
    events: [{ ...event, event_id: 'two' }],
  });
});

it('blocks uploads immediately when even the opt-out marker cannot be written', async () => {
  recordInsight(insightsScope(), event);
  mockConfig.insightsSyncEnabled = true;
  const original = localStorage.setItem;
  localStorage.setItem = () => {
    throw new Error('storage unavailable');
  };
  await expect(setInsightsSyncConsent(false)).rejects.toThrow('storage unavailable');
  localStorage.setItem = original;
  await refreshInsights();
  expect(mockConfig.insightsSyncEnabled).toBe(true);
  expect(api.post).not.toHaveBeenCalled();
  expect(api.get).not.toHaveBeenCalled();
  await setInsightsSyncConsent(true);
  expect(api.post).toHaveBeenCalledTimes(1);
  await refreshInsights();
});
it('keeps the in-memory opt-out if clearing the durable marker fails', async () => {
  recordInsight(insightsScope(), event);
  await setInsightsSyncConsent(false);
  const original = localStorage.removeItem;
  localStorage.removeItem = () => {
    throw new Error('storage unavailable');
  };
  await expect(setInsightsSyncConsent(true)).rejects.toThrow('storage unavailable');
  localStorage.removeItem = original;
  // Even if another actor clears the marker, a failed opt-in must not authorize sync.
  memory.delete('android-insights-opt-out');
  await refreshInsights();
  expect(api.post).not.toHaveBeenCalled();
  expect(api.get).not.toHaveBeenCalled();
});
it('discards an in-flight acknowledgement after an opt-out marker write failure', async () => {
  recordInsight(insightsScope(), event);
  mockConfig.insightsSyncEnabled = true;
  let resolve!: (value: unknown) => void;
  jest.mocked(api.post).mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const pending = refreshInsights();
  const original = localStorage.setItem;
  localStorage.setItem = () => {
    throw new Error('storage unavailable');
  };
  await expect(setInsightsSyncConsent(false)).rejects.toThrow('storage unavailable');
  localStorage.setItem = original;
  resolve({ accepted: ['one'], rejected: [] });
  await pending;
  expect(api.get).not.toHaveBeenCalled();
  expect(useInsights.getState().ledger.acknowledged).toEqual([]);
});
it('keeps loading visible when a second refresh joins an existing request', async () => {
  mockConfig.insightsSyncEnabled = true;
  let resolve!: (value: unknown) => void;
  jest.mocked(api.get).mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const first = refreshInsights();
  const second = refreshInsights();
  expect(useInsights.getState().status).toBe('loading');
  resolve({ totalWords: 0, totalDictations: 0 });
  await Promise.all([first, second]);
  expect(useInsights.getState().status).toBe('idle');
});
it('uploads more than 200 events in bounded batches and retries after transport failure', async () => {
  for (let i = 0; i < 401; i++) recordInsight(insightsScope(), { ...event, event_id: String(i) });
  mockConfig.insightsSyncEnabled = true;
  jest.mocked(api.post).mockRejectedValueOnce(new Error('offline'));
  await refreshInsights();
  expect(useInsights.getState().ledger.acknowledged).toEqual([]);
  jest.mocked(api.post).mockImplementation(async (_path, body) => ({
    accepted: (body as { events: InsightEvent[] }).events.map((item) => item.event_id),
    rejected: [],
  }));
  await refreshInsights();
  expect(
    jest
      .mocked(api.post)
      .mock.calls.map((call) => (call[1] as { events: InsightEvent[] }).events.length),
  ).toEqual([200, 200, 200, 1]);
  expect(useInsights.getState().ledger.acknowledged).toHaveLength(401);
});
it('never applies account A responses to account B after an in-flight switch', async () => {
  recordInsight(insightsScope(), event);
  mockConfig.insightsSyncEnabled = true;
  let resolve!: (value: unknown) => void;
  jest.mocked(api.post).mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const first = refreshInsights();
  mockUser = { id: 'b' };
  await Promise.resolve();
  const second = refreshInsights();
  expect(useInsights.getState().ledger.events).toEqual([]);
  resolve({ accepted: ['one'], rejected: [] });
  await Promise.all([first, second]);
  await refreshInsights();
  expect(useInsights.getState().scope).toBe('account:b');
  expect(useInsights.getState().ledger.events).toEqual([]);
  expect(JSON.parse(memory.get('android-insights-v1:account:a')!).acknowledged).toEqual([]);
});

it('allows opt-out while the opt-in sync request is still pending', async () => {
  let resolve!: (value: unknown) => void;
  jest.mocked(api.get).mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  await setInsightsSyncConsent(true);
  expect(useInsights.getState().status).toBe('loading');
  const pending = refreshInsights();
  await setInsightsSyncConsent(false);
  expect(useInsights.getState().consentPaused).toBe(true);
  resolve({ totalWords: 100, totalDictations: 5 });
  await pending;
  await Promise.resolve();
  expect(useInsights.getState().ledger.summary).toBeUndefined();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function changeAccount(id: string, sessionCookie = `synthetic-session-${id}`) {
  mockUser = { id };
  mockSessionCookie = sessionCookie;
  [...mockAuthListeners].forEach((listener) => listener());
}

it('aborts a pending statistics upload immediately even if persisting opt-out fails', async () => {
  recordInsight(insightsScope(), event);
  mockConfig.insightsSyncEnabled = true;
  const response = deferred<{ accepted: string[]; rejected: string[] }>();
  jest.mocked(api.post).mockReturnValueOnce(response.promise);
  const pending = refreshInsights();
  const signal = jest.mocked(api.post).mock.calls[0][2]?.signal;
  const originalSetItem = localStorage.setItem;
  localStorage.setItem = () => {
    throw new Error('storage unavailable');
  };
  try {
    const optOut = setInsightsSyncConsent(false);
    await expect(optOut).rejects.toThrow('storage unavailable');
    expect(signal?.aborted).toBe(true);
    expect(useInsights.getState().status).toBe('idle');
  } finally {
    localStorage.setItem = originalSetItem;
    response.resolve({ accepted: ['one'], rejected: [] });
    await pending;
  }
  expect(useInsights.getState().ledger.events).toEqual([event]);
  expect(useInsights.getState().ledger.acknowledged).toEqual([]);
  expect(api.get).not.toHaveBeenCalled();
});

it('starts a fresh run after OFF then ON and ignores the old acknowledgement', async () => {
  recordInsight(insightsScope(), event);
  mockConfig.insightsSyncEnabled = true;
  const oldResponse = deferred<{ accepted: string[]; rejected: string[] }>();
  const newResponse = deferred<{ accepted: string[]; rejected: string[] }>();
  jest
    .mocked(api.post)
    .mockReturnValueOnce(oldResponse.promise)
    .mockReturnValueOnce(newResponse.promise);
  const oldRun = refreshInsights();
  let newRun: Promise<void> | undefined;
  try {
    await setInsightsSyncConsent(false);
    await setInsightsSyncConsent(true);
    newRun = refreshInsights();
    expect(api.post).toHaveBeenCalledTimes(2);
    oldResponse.resolve({ accepted: ['one'], rejected: [] });
    await oldRun;
    expect(useInsights.getState().ledger.acknowledged).toEqual([]);
    expect(useInsights.getState().status).toBe('loading');
    expect(refreshInsights()).toBe(newRun);
  } finally {
    oldResponse.resolve({ accepted: ['one'], rejected: [] });
    newResponse.resolve({ accepted: ['one'], rejected: [] });
    await Promise.all([oldRun, newRun]);
  }
  expect(useInsights.getState().ledger.events).toEqual([event]);
  expect(useInsights.getState().ledger.acknowledged).toEqual(['one']);
});

it('invalidates an A to B to A round trip even when the old transport ignores abort', async () => {
  recordInsight(insightsScope(), event);
  mockConfig.insightsSyncEnabled = true;
  const oldResponse = deferred<{ accepted: string[]; rejected: string[] }>();
  const newResponse = deferred<{ accepted: string[]; rejected: string[] }>();
  jest
    .mocked(api.post)
    .mockReturnValueOnce(oldResponse.promise)
    .mockReturnValueOnce(newResponse.promise);
  const oldRun = refreshInsights();
  const oldSignal = jest.mocked(api.post).mock.calls[0][2]?.signal;
  let newRun: Promise<void> | undefined;
  try {
    changeAccount('b');
    changeAccount('a');
    newRun = refreshInsights();
    expect(oldSignal?.aborted).toBe(true);
    expect(api.post).toHaveBeenCalledTimes(2);
    oldResponse.resolve({ accepted: ['one'], rejected: [] });
    await oldRun;
    expect(useInsights.getState().ledger.acknowledged).toEqual([]);
    expect(useInsights.getState().status).toBe('loading');
    expect(refreshInsights()).toBe(newRun);
  } finally {
    oldResponse.resolve({ accepted: ['one'], rejected: [] });
    newResponse.resolve({ accepted: ['one'], rejected: [] });
    await Promise.all([oldRun, newRun]);
  }
  expect(useInsights.getState().scope).toBe('account:a');
  expect(useInsights.getState().ledger.events).toEqual([event]);
  expect(JSON.parse(memory.get('android-insights-v1:account:a')!).acknowledged).toEqual(['one']);
});

it('cancels a pending summary when history is disabled without waiting for the screen to refresh', async () => {
  mockConfig.insightsSyncEnabled = true;
  const response = deferred<{ totalWords: number; totalDictations: number }>();
  jest.mocked(api.get).mockReturnValueOnce(response.promise);
  const pending = refreshInsights();
  const signal = jest.mocked(api.get).mock.calls[0][1]?.signal;
  try {
    mockConfig.androidHistoryDays = 0;
    [...mockConfigListeners].forEach((listener) => listener());
    expect(signal?.aborted).toBe(true);
    expect(useInsights.getState().status).toBe('idle');
  } finally {
    response.resolve({ totalWords: 100, totalDictations: 5 });
    await pending;
  }
  expect(useInsights.getState().ledger.summary).toBeUndefined();
});

it('replaces a same-account session without letting its late error overwrite the new run', async () => {
  mockConfig.insightsSyncEnabled = true;
  const oldResponse = deferred<{ totalWords: number; totalDictations: number }>();
  const newResponse = deferred<{ totalWords: number; totalDictations: number }>();
  jest
    .mocked(api.get)
    .mockReturnValueOnce(oldResponse.promise)
    .mockReturnValueOnce(newResponse.promise);
  const oldRun = refreshInsights();
  const oldSignal = jest.mocked(api.get).mock.calls[0][1]?.signal;
  let newRun: Promise<void> | undefined;
  try {
    changeAccount('a', 'synthetic-replacement-session-a');
    newRun = refreshInsights();
    expect(oldSignal?.aborted).toBe(true);
    expect(api.get).toHaveBeenCalledTimes(2);
    oldResponse.reject(new ApiError('old policy response', 403, 'POLICY_CLOUD_BACKUP_BLOCKED'));
    await oldRun;
    expect(useInsights.getState().status).toBe('loading');
    expect(refreshInsights()).toBe(newRun);
  } finally {
    oldResponse.resolve({ totalWords: 999, totalDictations: 999 });
    newResponse.resolve({ totalWords: 20, totalDictations: 4 });
    await Promise.all([oldRun, newRun]);
  }
  expect(useInsights.getState().ledger.summary).toEqual({ totalWords: 20, totalDictations: 4 });
  expect(mockAuthListeners.size).toBe(0);
  expect(mockConfigListeners.size).toBe(0);
});

it('aborts a deleted account upload and never recreates its erased ledger', async () => {
  recordInsight(insightsScope(), event);
  mockConfig.insightsSyncEnabled = true;
  const response = deferred<{ accepted: string[]; rejected: string[] }>();
  jest.mocked(api.post).mockReturnValueOnce(response.promise);
  const pending = refreshInsights();
  const signal = jest.mocked(api.post).mock.calls[0][2]?.signal;
  try {
    eraseAccountInsights('a');
    expect(signal?.aborted).toBe(true);
    expect(mockAuthListeners.size).toBe(0);
    expect(mockConfigListeners.size).toBe(0);
  } finally {
    response.resolve({ accepted: ['one'], rejected: [] });
    await pending;
  }
  expect(memory.has('android-insights-v1:account:a')).toBe(false);
  expect(memory.get('android-insights-v1:account:a:deleted')).toBe('true');
  expect(useInsights.getState().ledger.events).toEqual([]);
  expect(api.get).not.toHaveBeenCalled();
});

it('retains acknowledged progress but stops further batches until a fresh opt-in', async () => {
  const events = Array.from({ length: 401 }, (_, index) => ({ ...event, event_id: String(index) }));
  events.forEach((item) => recordInsight(insightsScope(), item));
  mockConfig.insightsSyncEnabled = true;
  const secondResponse = deferred<{ accepted: string[]; rejected: string[] }>();
  const secondStarted = deferred<void>();
  jest
    .mocked(api.post)
    .mockResolvedValueOnce({
      accepted: events.slice(0, 200).map((item) => item.event_id),
      rejected: [],
    })
    .mockImplementationOnce(() => {
      secondStarted.resolve();
      return secondResponse.promise;
    });
  const pending = refreshInsights();
  await secondStarted.promise;
  const signal = jest.mocked(api.post).mock.calls[1]?.[2]?.signal;
  try {
    expect(api.post).toHaveBeenCalledTimes(2);
    await setInsightsSyncConsent(false);
    expect(signal?.aborted).toBe(true);
  } finally {
    secondResponse.resolve({
      accepted: events.slice(200, 400).map((item) => item.event_id),
      rejected: [],
    });
    await pending;
  }
  expect(api.post).toHaveBeenCalledTimes(2);
  expect(api.get).not.toHaveBeenCalled();
  expect(useInsights.getState().ledger.acknowledged).toHaveLength(200);
  expect(useInsights.getState().ledger.events).toEqual(events);
  jest.mocked(api.post).mockImplementation(async (_path, body) => ({
    accepted: (body as { events: InsightEvent[] }).events.map((item) => item.event_id),
    rejected: [],
  }));
  await setInsightsSyncConsent(true);
  await refreshInsights();
  expect(jest.mocked(api.post).mock.calls[2][1]).toEqual({ events: events.slice(200, 400) });
  expect(jest.mocked(api.post).mock.calls[3][1]).toEqual({ events: events.slice(400) });
  expect(useInsights.getState().ledger.acknowledged).toHaveLength(401);
});

it.each(['upload', 'summary'] as const)(
  'bounds a stalled %s request, permits retry, and ignores a late response',
  async (phase) => {
    jest.useFakeTimers();
    recordInsight(insightsScope(), event);
    mockConfig.insightsSyncEnabled = true;
    const heldUpload = deferred<{ accepted: string[]; rejected: string[] }>();
    const heldSummary = deferred<{ totalWords: number; totalDictations: number }>();
    if (phase === 'upload') jest.mocked(api.post).mockReturnValueOnce(heldUpload.promise);
    else jest.mocked(api.get).mockReturnValueOnce(heldSummary.promise);
    let settled = false;
    const pending = refreshInsights().then(() => {
      settled = true;
    });
    try {
      await jest.advanceTimersByTimeAsync(0);
      const signal =
        phase === 'upload'
          ? jest.mocked(api.post).mock.calls[0][2]?.signal
          : jest.mocked(api.get).mock.calls[0][1]?.signal;
      await jest.advanceTimersByTimeAsync(30_000);
      expect(signal?.aborted).toBe(true);
      expect(settled).toBe(true);
      expect(useInsights.getState().status).toBe('offline');
      expect(useInsights.getState().ledger.events).toEqual([event]);
      expect(useInsights.getState().ledger.acknowledged).toEqual(phase === 'upload' ? [] : ['one']);
      expect(mockAuthListeners.size).toBe(0);
      expect(mockConfigListeners.size).toBe(0);
      // A retry can complete before the old transport settles. The upload retry
      // deliberately leaves the ID unacknowledged to detect a late old ack.
      if (phase === 'upload')
        jest.mocked(api.post).mockResolvedValueOnce({ accepted: [], rejected: [] });
      await refreshInsights();
      expect(useInsights.getState().status).toBe('idle');
      expect(useInsights.getState().ledger.summary).toEqual({ totalWords: 10, totalDictations: 3 });
      heldUpload.resolve({ accepted: ['one'], rejected: [] });
      heldSummary.resolve({ totalWords: 999, totalDictations: 999 });
      await jest.advanceTimersByTimeAsync(0);
      expect(useInsights.getState().ledger.acknowledged).toEqual(phase === 'upload' ? [] : ['one']);
      expect(useInsights.getState().ledger.summary).toEqual({ totalWords: 10, totalDictations: 3 });
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      heldUpload.resolve({ accepted: ['one'], rejected: [] });
      heldSummary.resolve({ totalWords: 999, totalDictations: 999 });
      await pending;
      jest.useRealTimers();
    }
  },
);

it('gives each batch its own deadline and retries only the unacknowledged remainder', async () => {
  jest.useFakeTimers();
  const events = Array.from({ length: 401 }, (_, index) => ({ ...event, event_id: String(index) }));
  events.forEach((item) => recordInsight(insightsScope(), item));
  mockConfig.insightsSyncEnabled = true;
  const first = deferred<{ accepted: string[]; rejected: string[] }>();
  const second = deferred<{ accepted: string[]; rejected: string[] }>();
  jest.mocked(api.post).mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
  const pending = refreshInsights();
  try {
    await jest.advanceTimersByTimeAsync(20_000);
    first.resolve({ accepted: events.slice(0, 200).map((item) => item.event_id), rejected: [] });
    await jest.advanceTimersByTimeAsync(0);
    expect(api.post).toHaveBeenCalledTimes(2);
    const signal = jest.mocked(api.post).mock.calls[1][2]?.signal;
    await jest.advanceTimersByTimeAsync(20_000);
    expect(signal?.aborted).toBe(false);
    expect(useInsights.getState().status).toBe('loading');
    await jest.advanceTimersByTimeAsync(10_000);
    await pending;
    expect(signal?.aborted).toBe(true);
    expect(useInsights.getState().status).toBe('offline');
    expect(useInsights.getState().ledger.acknowledged).toHaveLength(200);
    expect(api.post).toHaveBeenCalledTimes(2);
    jest.mocked(api.post).mockImplementation(async (_path, body) => ({
      accepted: (body as { events: InsightEvent[] }).events.map((item) => item.event_id),
      rejected: [],
    }));
    await refreshInsights();
    expect(jest.mocked(api.post).mock.calls[2][1]).toEqual({ events: events.slice(200, 400) });
    expect(jest.mocked(api.post).mock.calls[3][1]).toEqual({ events: events.slice(400) });
    expect(useInsights.getState().ledger.acknowledged).toHaveLength(401);
    expect(useInsights.getState().status).toBe('idle');
    expect(jest.getTimerCount()).toBe(0);
  } finally {
    first.resolve({ accepted: [], rejected: [] });
    second.resolve({ accepted: [], rejected: [] });
    await pending;
    jest.useRealTimers();
  }
});

it('removes the old deadline when accounts change without marking the new account offline early', async () => {
  jest.useFakeTimers();
  mockConfig.insightsSyncEnabled = true;
  const oldSummary = deferred<{ totalWords: number; totalDictations: number }>();
  const newSummary = deferred<{ totalWords: number; totalDictations: number }>();
  jest
    .mocked(api.get)
    .mockReturnValueOnce(oldSummary.promise)
    .mockReturnValueOnce(newSummary.promise);
  const first = refreshInsights();
  let second: Promise<void> | undefined;
  try {
    await jest.advanceTimersByTimeAsync(10_000);
    changeAccount('b');
    second = refreshInsights();
    await jest.advanceTimersByTimeAsync(20_000);
    expect(useInsights.getState().scope).toBe('account:b');
    expect(useInsights.getState().status).toBe('loading');
    expect(jest.mocked(api.get).mock.calls[1][1]?.signal?.aborted).toBe(false);
    await jest.advanceTimersByTimeAsync(10_000);
    await Promise.all([first, second]);
    expect(useInsights.getState().status).toBe('offline');
    oldSummary.resolve({ totalWords: 999, totalDictations: 999 });
    newSummary.resolve({ totalWords: 888, totalDictations: 888 });
    await jest.advanceTimersByTimeAsync(0);
    expect(useInsights.getState().ledger.summary).toBeUndefined();
    expect(jest.getTimerCount()).toBe(0);
  } finally {
    oldSummary.resolve({ totalWords: 999, totalDictations: 999 });
    newSummary.resolve({ totalWords: 888, totalDictations: 888 });
    await Promise.all([first, second]);
    jest.useRealTimers();
  }
});

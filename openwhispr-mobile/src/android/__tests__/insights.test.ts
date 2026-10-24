const memory = new Map<string, string>();
let mockUser: { id: string; isAnonymous?: boolean } | null = { id: 'a' };
let mockSaveError: string | null = null;
let mockConfig = { androidHistoryDays: 30, insightsSyncEnabled: false };
jest.mock('@/store/useAuthStore', () => ({
  useAuthStore: { getState: () => ({ user: mockUser }) },
}));
jest.mock('@/store/useConfigStore', () => ({
  useConfigStore: {
    getState: () => ({
      config: mockConfig,
      error: mockSaveError,
      updateConfig: async (change: object) => {
        if (!mockSaveError) Object.assign(mockConfig, change);
      },
    }),
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
    { headers: { 'x-openwhispr-source': 'mobile' } },
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

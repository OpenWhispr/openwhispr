import type { UserConfig } from '@/types';

type MilestoneModule = typeof import('../dictationMilestone');
type DictationInput = Parameters<MilestoneModule['recordDictationMilestone']>[0];

const STORAGE_KEY = 'openwhispr.dictation-milestone.v1';
const DAY_MS = 86_400_000;
const INSTALLED_AT = Date.UTC(2026, 10, 1);

const stored = new Map<string, string>();
let mockConfig: UserConfig | null = { defaultMode: 'cloud', usageAnalyticsEnabled: true };
const mockConfigListeners = new Set<() => void>();
const mockAttributionListeners = new Set<() => void>();
const mockConfirm = jest.fn<Promise<boolean>, [string, Record<string, unknown>?]>();
const mockInstallationTime = jest.fn<Promise<Date>, []>();
const mockPlatform = { OS: 'ios' };

jest.mock('expo-sqlite/localStorage/install', () => ({}));
jest.mock('react-native', () => ({ Platform: mockPlatform }));
jest.mock('expo-application', () => ({
  getInstallationTimeAsync: (): Promise<Date> => mockInstallationTime(),
}));
jest.mock('@/lib/appsflyer', () => ({
  logAppsFlyerEventConfirmed: (name: string, values?: Record<string, unknown>): Promise<boolean> =>
    mockConfirm(name, values),
  subscribeAppsFlyerAttribution: (listener: () => void): (() => void) => {
    mockAttributionListeners.add(listener);
    return (): void => {
      mockAttributionListeners.delete(listener);
    };
  },
}));
jest.mock('@/store/useConfigStore', () => ({
  useConfigStore: {
    getState: (): { config: UserConfig | null } => ({ config: mockConfig }),
    subscribe: (listener: () => void): (() => void) => {
      mockConfigListeners.add(listener);
      return (): void => {
        mockConfigListeners.delete(listener);
      };
    },
  },
}));

function load(): MilestoneModule {
  jest.resetModules();
  mockConfigListeners.clear();
  mockAttributionListeners.clear();
  return require('../dictationMilestone') as MilestoneModule;
}

let captureCount = 0;
function dictation(count: number | null, overrides: Partial<DictationInput> = {}): DictationInput {
  captureCount += 1;
  return {
    context: { identity: null, isPractice: false, consentSignal: null },
    captureId: `capture-${captureCount}`,
    words: count,
    provider: 'local',
    source: 'dictation',
    retranscribe: false,
    ...overrides,
  };
}

function storedState(): Record<string, unknown> | null {
  const json = stored.get(STORAGE_KEY);
  return json ? (JSON.parse(json) as Record<string, unknown>) : null;
}

function setConfig(config: UserConfig | null): void {
  mockConfig = config;
  mockConfigListeners.forEach((listener) => listener());
}

function sdkBecameReady(): void {
  mockAttributionListeners.forEach((listener) => listener());
}

function flushPromises(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

beforeEach(() => {
  stored.clear();
  mockConfig = { defaultMode: 'cloud', usageAnalyticsEnabled: true };
  mockPlatform.OS = 'ios';
  mockConfirm.mockReset().mockResolvedValue(true);
  mockInstallationTime.mockReset().mockResolvedValue(new Date(INSTALLED_AT));
  jest.spyOn(Date, 'now').mockReturnValue(INSTALLED_AT + 2 * DAY_MS);
  jest.spyOn(console, 'warn').mockImplementation((): void => undefined);
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string): string | null => stored.get(key) ?? null,
      setItem: (key: string, value: string): void => {
        stored.set(key, value);
      },
      removeItem: (key: string): void => {
        stored.delete(key);
      },
    },
  });
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('dictated_200_words milestone', () => {
  it('sends once at 199 + 1 words, with non-content values only', async () => {
    const milestone = load();
    milestone.recordDictationMilestone(dictation(199, { source: 'keyboard' }));
    await flushPromises();
    expect(mockConfirm).not.toHaveBeenCalled();
    expect(storedState()).toMatchObject({ words: 199, status: 'counting' });

    milestone.recordDictationMilestone(dictation(1, { source: 'keyboard', provider: 'cloud' }));
    await flushPromises();

    expect(mockConfirm).toHaveBeenCalledTimes(1);
    expect(mockConfirm).toHaveBeenCalledWith('dictated_200_words', {
      transcription_mode: 'cloud',
      input_source: 'keyboard',
      days_since_install_bucket: '2-3',
    });
    expect(storedState()).toMatchObject({ words: 200, status: 'sent' });
  });

  it('never sends again after more words, more flushes or a relaunch', async () => {
    const milestone = load();
    milestone.recordDictationMilestone(dictation(250));
    await flushPromises();
    milestone.recordDictationMilestone(dictation(500));
    await milestone.flushDictationMilestone();

    const relaunched = load();
    relaunched.initDictationMilestone();
    sdkBecameReady();
    await flushPromises();

    expect(mockConfirm).toHaveBeenCalledTimes(1);
    expect(storedState()).toMatchObject({ words: 200, status: 'sent' });
  });

  it('counts in-app and keyboard dictation together', async () => {
    const milestone = load();
    milestone.recordDictationMilestone(dictation(120, { source: 'keyboard' }));
    milestone.recordDictationMilestone(dictation(80, { source: 'dictation' }));
    await flushPromises();

    expect(mockConfirm).toHaveBeenCalledWith(
      'dictated_200_words',
      expect.objectContaining({ input_source: 'app', transcription_mode: 'local' }),
    );
  });

  it('ignores onboarding practice, re-transcriptions and uncountable dictations', async () => {
    const milestone = load();
    milestone.recordDictationMilestone(
      dictation(300, { context: { identity: null, isPractice: true, consentSignal: null } }),
    );
    milestone.recordDictationMilestone(dictation(300, { retranscribe: true }));
    milestone.recordDictationMilestone(dictation(null));
    milestone.recordDictationMilestone(dictation(0));
    await flushPromises();

    expect(mockConfirm).not.toHaveBeenCalled();
    expect(storedState()).toBeNull();
  });

  it('counts one recording once however often it is reported', async () => {
    const milestone = load();
    const report = dictation(150);
    milestone.recordDictationMilestone(report);
    milestone.recordDictationMilestone(report);
    await flushPromises();

    expect(storedState()).toMatchObject({ words: 150, status: 'counting' });
  });

  it('does not count while Usage Analytics is off or not loaded', async () => {
    const milestone = load();
    setConfig(null);
    milestone.recordDictationMilestone(dictation(300));
    setConfig({ defaultMode: 'cloud', usageAnalyticsEnabled: false });
    milestone.recordDictationMilestone(dictation(300));
    await flushPromises();

    expect(mockConfirm).not.toHaveBeenCalled();
    expect(storedState()).toBeNull();
  });

  it('keeps the milestone pending until AppsFlyer confirms, then sends when the SDK is ready', async () => {
    mockConfirm.mockResolvedValueOnce(false);
    const milestone = load();
    milestone.initDictationMilestone();
    milestone.recordDictationMilestone(dictation(200));
    await flushPromises();
    expect(storedState()).toMatchObject({ status: 'pending' });

    sdkBecameReady();
    await flushPromises();

    expect(mockConfirm).toHaveBeenCalledTimes(2);
    expect(storedState()).toMatchObject({ status: 'sent' });
  });

  it('re-sends a pending milestone after a relaunch, with the values from the crossing', async () => {
    mockConfirm.mockResolvedValueOnce(false);
    const milestone = load();
    milestone.recordDictationMilestone(dictation(200, { provider: 'byok', source: 'keyboard' }));
    await flushPromises();
    (Date.now as jest.Mock).mockReturnValue(INSTALLED_AT + 30 * DAY_MS);

    const relaunched = load();
    relaunched.initDictationMilestone();
    await flushPromises();

    expect(mockConfirm).toHaveBeenLastCalledWith('dictated_200_words', {
      transcription_mode: 'byok',
      input_source: 'keyboard',
      days_since_install_bucket: '2-3',
    });
    expect(storedState()).toMatchObject({ status: 'sent' });
  });

  it('suppresses a pending milestone when Usage Analytics is turned off, for good', async () => {
    mockConfirm.mockResolvedValue(false);
    const milestone = load();
    milestone.initDictationMilestone();
    milestone.recordDictationMilestone(dictation(200));
    await flushPromises();

    setConfig({ defaultMode: 'cloud', usageAnalyticsEnabled: false });
    expect(storedState()).toMatchObject({ status: 'suppressed' });

    mockConfirm.mockResolvedValue(true);
    setConfig({ defaultMode: 'cloud', usageAnalyticsEnabled: true });
    sdkBecameReady();
    await milestone.flushDictationMilestone();

    expect(mockConfirm).toHaveBeenCalledTimes(1);
    expect(storedState()).toMatchObject({ status: 'suppressed' });
  });

  it('records a send AppsFlyer confirmed during an opt-out as sent', async () => {
    const confirm = deferred<boolean>();
    mockConfirm.mockReturnValueOnce(confirm.promise);
    const milestone = load();
    milestone.initDictationMilestone();
    milestone.recordDictationMilestone(dictation(200));
    await flushPromises();

    setConfig({ defaultMode: 'cloud', usageAnalyticsEnabled: false });
    confirm.resolve(true);
    await flushPromises();

    expect(storedState()).toMatchObject({ status: 'sent' });
  });

  it('shares one in-flight send between concurrent flushes', async () => {
    const confirm = deferred<boolean>();
    mockConfirm.mockReturnValueOnce(confirm.promise);
    const milestone = load();
    milestone.recordDictationMilestone(dictation(200));
    const first = milestone.flushDictationMilestone();
    const second = milestone.flushDictationMilestone();
    confirm.resolve(true);
    await Promise.all([first, second]);

    expect(mockConfirm).toHaveBeenCalledTimes(1);
  });

  it('counts on Android but holds the milestone until Android has a consent step', async () => {
    mockPlatform.OS = 'android';
    const milestone = load();
    milestone.initDictationMilestone();
    milestone.recordDictationMilestone(dictation(200));
    sdkBecameReady();
    await flushPromises();

    expect(mockConfirm).not.toHaveBeenCalled();
    expect(storedState()).toMatchObject({ words: 200, status: 'pending' });
  });

  it('leaves out the install age when the install time cannot be read', async () => {
    mockInstallationTime.mockRejectedValue(new Error('unavailable'));
    const milestone = load();
    milestone.recordDictationMilestone(dictation(200));
    await flushPromises();

    expect(mockConfirm).toHaveBeenCalledWith('dictated_200_words', {
      transcription_mode: 'local',
      input_source: 'app',
    });
  });

  it.each([
    [0, '0'],
    [1, '1'],
    [3, '2-3'],
    [7, '4-7'],
    [14, '8-14'],
    [40, '15+'],
  ])('buckets a crossing %i days after install as %s', async (days, bucket) => {
    (Date.now as jest.Mock).mockReturnValue(INSTALLED_AT + days * DAY_MS + 60_000);
    const milestone = load();
    milestone.recordDictationMilestone(dictation(200));
    await flushPromises();

    expect(mockConfirm).toHaveBeenCalledWith(
      'dictated_200_words',
      expect.objectContaining({ days_since_install_bucket: bucket }),
    );
  });

  it('keeps working for the session when storage throws, and never throws itself', async () => {
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: {
        getItem: (): string | null => {
          throw new Error('disk');
        },
        setItem: (): void => {
          throw new Error('disk');
        },
        removeItem: (): void => undefined,
      },
    });
    const milestone = load();

    expect(() => milestone.recordDictationMilestone(dictation(200))).not.toThrow();
    await flushPromises();
    await milestone.flushDictationMilestone();

    expect(mockConfirm).toHaveBeenCalledTimes(1);
  });

  it('starts from zero: words dictated before this update are never counted', () => {
    load();
    expect(storedState()).toBeNull();
  });
});

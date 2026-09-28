import { fetchUsage, type UsageInfo } from '@/data/remote/usageApi';
import { useAuthStore } from '@/store/useAuthStore';
import { useUsageStore } from '@/store/useUsageStore';

jest.mock('@/data/remote/usageApi', () => ({
  fetchUsage: jest.fn(),
}));

jest.mock('@/store/useAuthStore', () => {
  type MockAuthState = {
    user: { id: string; email: string; emailVerified: boolean } | null;
    sessionCookie: string | null;
    isGuest: boolean;
    isInitialized: boolean;
    isLoading: boolean;
  };

  let state: MockAuthState = {
    user: null,
    sessionCookie: null,
    isGuest: false,
    isInitialized: true,
    isLoading: false,
  };

  return {
    useAuthStore: {
      getState: () => state,
      setState: (patch: Partial<MockAuthState>) => {
        state = { ...state, ...patch };
      },
    },
  };
});

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
};

const mockFetchUsage = fetchUsage as jest.MockedFunction<typeof fetchUsage>;

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function usage(overrides: Partial<UsageInfo> = {}): UsageInfo {
  return {
    billingUserId: '00000000-0000-4000-8000-000000000001',
    wordsUsed: 100,
    wordsRemaining: 1_900,
    limit: 2_000,
    plan: 'free',
    status: 'free',
    isSubscribed: false,
    isTrial: false,
    trialDaysLeft: null,
    currentPeriodEnd: null,
    billingInterval: null,
    resetAt: '2026-08-06T00:00:00.000Z',
    ...overrides,
  };
}

function setSignedInUser(id: string, sessionCookie: string): void {
  useAuthStore.setState({
    user: { id, email: `${id}@example.com`, emailVerified: true, isAnonymous: false },
    sessionCookie,
    isGuest: false,
    isInitialized: true,
  });
}

describe('useUsageStore', () => {
  beforeEach(() => {
    mockFetchUsage.mockReset();
    useUsageStore.getState().reset();
    useAuthStore.setState({
      user: null,
      sessionCookie: null,
      isGuest: false,
      isInitialized: true,
      isLoading: false,
    });
  });

  it('loads usage and stamps loadedAt', async () => {
    setSignedInUser('user-a', 'cookie-a');
    mockFetchUsage.mockResolvedValue(usage());

    await expect(useUsageStore.getState().load()).resolves.toMatchObject({ status: 'loaded' });

    expect(useUsageStore.getState().usage).toEqual(usage());
    expect(useUsageStore.getState().isLoading).toBe(false);
    expect(useUsageStore.getState().loadedAt).toBeGreaterThan(0);
  });

  it('serves an unforced load from cache within the TTL', async () => {
    setSignedInUser('user-a', 'cookie-a');
    mockFetchUsage.mockResolvedValue(usage());

    await useUsageStore.getState().load();
    await expect(useUsageStore.getState().load()).resolves.toMatchObject({
      status: 'skipped',
      reason: 'fresh',
    });

    expect(mockFetchUsage).toHaveBeenCalledTimes(1);
  });

  it('coalesces an unforced load into one already in flight', async () => {
    const firstRequest = deferred<UsageInfo>();
    mockFetchUsage.mockReturnValueOnce(firstRequest.promise);
    setSignedInUser('user-a', 'cookie-a');

    const inFlight = useUsageStore.getState().load();
    await expect(useUsageStore.getState().load()).resolves.toMatchObject({
      status: 'skipped',
      reason: 'loading',
    });

    expect(mockFetchUsage).toHaveBeenCalledTimes(1);
    firstRequest.resolve(usage());
    await inFlight;
  });

  it('does not let an old auth request repopulate usage after reset/sign-in', async () => {
    const firstRequest = deferred<UsageInfo>();
    mockFetchUsage.mockReturnValueOnce(firstRequest.promise);

    setSignedInUser('user-a', 'cookie-a');
    const loadPromise = useUsageStore.getState().load(true);

    useUsageStore.getState().reset();
    setSignedInUser('user-b', 'cookie-b');

    firstRequest.resolve(usage({ plan: 'pro', isSubscribed: true }));
    await expect(loadPromise).resolves.toMatchObject({ status: 'stale' });
    expect(useUsageStore.getState().usage).toBeNull();
  });

  it('allows a forced refresh to supersede an in-flight normal load', async () => {
    const firstRequest = deferred<UsageInfo>();
    const secondRequest = deferred<UsageInfo>();
    mockFetchUsage
      .mockReturnValueOnce(firstRequest.promise)
      .mockReturnValueOnce(secondRequest.promise);

    setSignedInUser('user-a', 'cookie-a');
    const normalLoad = useUsageStore.getState().load();
    const forcedLoad = useUsageStore.getState().load(true);

    expect(mockFetchUsage).toHaveBeenCalledTimes(2);

    firstRequest.resolve(usage({ wordsRemaining: 0 }));
    await expect(normalLoad).resolves.toMatchObject({ status: 'stale' });
    expect(useUsageStore.getState().usage).toBeNull();

    secondRequest.resolve(usage({ plan: 'pro', isSubscribed: true }));
    await expect(forcedLoad).resolves.toMatchObject({ status: 'loaded' });
    expect(useUsageStore.getState().usage).toMatchObject({ plan: 'pro', isSubscribed: true });
  });

  it('returns failed without replacing the last fresh usage', async () => {
    mockFetchUsage.mockResolvedValueOnce(usage({ wordsRemaining: 500 }));
    setSignedInUser('user-a', 'cookie-a');

    await expect(useUsageStore.getState().load(true)).resolves.toMatchObject({ status: 'loaded' });
    mockFetchUsage.mockRejectedValueOnce(new Error('network down'));

    await expect(useUsageStore.getState().load(true)).resolves.toMatchObject({ status: 'failed' });
    expect(useUsageStore.getState().usage).toMatchObject({ wordsRemaining: 500 });
    expect(useUsageStore.getState().isLoading).toBe(false);
  });

  it('tracks the billing session and clears it on reset', () => {
    useUsageStore.getState().beginBillingSession();
    expect(useUsageStore.getState().isBillingSessionActive).toBe(true);

    useUsageStore.getState().endBillingSession();
    expect(useUsageStore.getState().isBillingSessionActive).toBe(false);

    useUsageStore.getState().beginBillingSession();
    useUsageStore.getState().reset();
    expect(useUsageStore.getState().isBillingSessionActive).toBe(false);
  });
});

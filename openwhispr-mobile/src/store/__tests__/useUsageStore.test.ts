import { fetchUsage, type UsageInfo } from '@/data/remote/usageApi';
import { useAuthStore } from '@/store/useAuthStore';
import { useUsageStore } from '@/store/useUsageStore';
import { ApiError } from '@/lib/apiClient';
import { Platform } from 'react-native';

jest.mock('expo/fetch', () => ({ fetch: jest.fn() }));

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
  const originalPlatform = Platform.OS;
  beforeEach(() => {
    Object.defineProperty(Platform, 'OS', { value: 'android', configurable: true });
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
  afterAll(() => {
    Object.defineProperty(Platform, 'OS', { value: originalPlatform, configurable: true });
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

  it('discards a rejected Android allowance without changing the local account', async () => {
    setSignedInUser('user-a', 'cookie-a');
    mockFetchUsage.mockResolvedValueOnce(usage({ plan: 'pro', isSubscribed: true }));
    await useUsageStore.getState().load(true);
    const account = useAuthStore.getState();
    mockFetchUsage.mockRejectedValueOnce(new ApiError('Invalid session', 401));

    await expect(useUsageStore.getState().load(true)).resolves.toMatchObject({
      status: 'failed',
      usage: null,
    });
    expect(useUsageStore.getState()).toMatchObject({
      usage: null,
      loadedAt: 0,
      sessionRejected: true,
      isLoading: false,
    });
    expect(useAuthStore.getState()).toEqual(account);
  });

  it.each([
    { name: 'offline', error: new Error('offline') },
    { name: 'server failure', error: new ApiError('unavailable', 503) },
    { name: 'policy refusal', error: new ApiError('policy', 403) },
  ])('retains cached access without demanding sign-in for $name', async ({ error }) => {
    setSignedInUser('user-a', 'cookie-a');
    mockFetchUsage.mockResolvedValueOnce(usage({ wordsRemaining: 500 }));
    await useUsageStore.getState().load(true);
    mockFetchUsage.mockRejectedValueOnce(error);
    await useUsageStore.getState().load(true);

    expect(useUsageStore.getState()).toMatchObject({
      usage: { wordsRemaining: 500 },
      sessionRejected: false,
    });
  });

  it('does not reject a replacement session when the old request fails late', async () => {
    setSignedInUser('user-a', 'cookie-a');
    const oldRequest = deferred<UsageInfo>();
    mockFetchUsage.mockReturnValueOnce(oldRequest.promise);
    const oldLoad = useUsageStore.getState().load(true);
    setSignedInUser('user-a', 'cookie-a-new');
    mockFetchUsage.mockResolvedValueOnce(usage({ wordsRemaining: 1800 }));
    await useUsageStore.getState().load(true);

    oldRequest.reject(new ApiError('Invalid session', 401));
    await expect(oldLoad).resolves.toMatchObject({ status: 'stale' });
    expect(useUsageStore.getState()).toMatchObject({
      usage: { wordsRemaining: 1800 },
      sessionRejected: false,
    });
  });

  it('does not let an older rejected request replace a newer successful refresh', async () => {
    setSignedInUser('user-a', 'cookie-a');
    const oldRequest = deferred<UsageInfo>();
    mockFetchUsage.mockReturnValueOnce(oldRequest.promise);
    const oldLoad = useUsageStore.getState().load(true);
    mockFetchUsage.mockResolvedValueOnce(usage({ wordsRemaining: 1800 }));
    await useUsageStore.getState().load(true);

    oldRequest.reject(new ApiError('Invalid session', 401));
    await expect(oldLoad).resolves.toMatchObject({ status: 'stale' });
    expect(useUsageStore.getState()).toMatchObject({
      usage: { wordsRemaining: 1800 },
      sessionRejected: false,
    });
  });

  it('clears session rejection after a successful refresh', async () => {
    setSignedInUser('user-a', 'cookie-a');
    mockFetchUsage.mockRejectedValueOnce(new ApiError('Invalid session', 401));
    await useUsageStore.getState().load(true);
    expect(useUsageStore.getState().sessionRejected).toBe(true);

    mockFetchUsage.mockResolvedValueOnce(usage());
    await expect(useUsageStore.getState().load()).resolves.toMatchObject({ status: 'loaded' });
    expect(useUsageStore.getState().sessionRejected).toBe(false);
  });

  it('does not carry another account rejection into an offline sign-in', async () => {
    setSignedInUser('user-a', 'cookie-a');
    mockFetchUsage.mockRejectedValueOnce(new ApiError('Invalid session', 401));
    await useUsageStore.getState().load(true);
    expect(useUsageStore.getState().sessionRejected).toBe(true);

    setSignedInUser('user-b', 'cookie-b');
    mockFetchUsage.mockRejectedValueOnce(new Error('offline'));
    await useUsageStore.getState().load(true);
    expect(useUsageStore.getState()).toMatchObject({ usage: null, sessionRejected: false });
  });

  it('clears a rejected session on sign-out reset', async () => {
    setSignedInUser('user-a', 'cookie-a');
    mockFetchUsage.mockRejectedValueOnce(new ApiError('Invalid session', 401));
    await useUsageStore.getState().load(true);
    expect(useUsageStore.getState().sessionRejected).toBe(true);

    useUsageStore.getState().reset();
    expect(useUsageStore.getState()).toMatchObject({ usage: null, sessionRejected: false });
  });

  it('preserves iOS cached-usage behavior when a request is rejected', async () => {
    Object.defineProperty(Platform, 'OS', { value: 'ios', configurable: true });
    setSignedInUser('user-a', 'cookie-a');
    mockFetchUsage.mockResolvedValueOnce(usage({ wordsRemaining: 500 }));
    await useUsageStore.getState().load(true);
    mockFetchUsage.mockRejectedValueOnce(new ApiError('Invalid session', 401));
    await useUsageStore.getState().load(true);

    expect(useUsageStore.getState()).toMatchObject({
      usage: { wordsRemaining: 500 },
      sessionRejected: false,
    });
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

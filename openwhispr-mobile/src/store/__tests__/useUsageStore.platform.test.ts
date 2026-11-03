import { Platform } from 'react-native';
import { fetchUsage, type UsageInfo } from '@/data/remote/usageApi';
import { ApiError } from '@/lib/apiClient';
import { useUsageStore as iosStore } from '../useUsageStore';
import { useUsageStore as androidStore } from '../useUsageStore.android';

let mockAuth = { user: { id: 'account-a' }, sessionCookie: 'cookie-a', isGuest: false };
jest.mock('expo/fetch', () => ({ fetch: jest.fn() }));
jest.mock('@/data/remote/usageApi', () => ({ fetchUsage: jest.fn() }));
jest.mock('@/store/useAuthStore', () => ({ useAuthStore: { getState: () => mockAuth } }));
const mockFetchUsage = jest.mocked(fetchUsage);

function deferred() {
  let resolve!: (value: UsageInfo) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<UsageInfo>((accept, fail) => {
    resolve = accept;
    reject = fail;
  });
  return { promise, resolve, reject };
}

const cachedUsage: UsageInfo = {
  billingUserId: 'fixture-a',
  wordsUsed: 100,
  wordsRemaining: 1900,
  limit: 2000,
  plan: 'free',
  status: 'free',
  isSubscribed: false,
  isTrial: false,
  trialDaysLeft: null,
  currentPeriodEnd: null,
  billingInterval: null,
  resetAt: '2026-11-02',
};
const originalPlatform = Platform.OS;
afterAll(() => Object.defineProperty(Platform, 'OS', { value: originalPlatform }));

describe.each([
  { platform: 'ios', store: iosStore },
  { platform: 'android', store: androidStore },
])('$platform usage store boundary', ({ platform, store }) => {
  beforeEach(() => {
    Object.defineProperty(Platform, 'OS', { value: platform, configurable: true });
    mockFetchUsage.mockReset();
    mockAuth = { user: { id: 'account-a' }, sessionCookie: 'cookie-a', isGuest: false };
    store.getState().reset();
  });

  it('preserves the complete current and initial public state shape', () => {
    const keys = [
      'usage',
      'isLoading',
      'loadedAt',
      'ownerKey',
      'activeRequestId',
      'isBillingSessionActive',
      'load',
      'beginBillingSession',
      'endBillingSession',
      'reset',
    ];
    if (platform === 'android') keys.push('sessionRejected');
    expect(Object.keys(store.getState()).sort()).toEqual(keys.sort());
    expect(Object.keys(store.getInitialState()).sort()).toEqual(keys.sort());
    expect(store.getState().load).toBe(store.getInitialState().load);
  });

  it.each(['owner', 'reset', 'replacement'])(
    'preserves a late failure after %s',
    async (reason) => {
      const oldRequest = deferred();
      mockFetchUsage.mockReturnValueOnce(oldRequest.promise);
      const oldLoad = store.getState().load(true);
      if (reason === 'owner')
        mockAuth = { ...mockAuth, user: { id: 'account-b' }, sessionCookie: 'cookie-b' };
      if (reason === 'reset') store.getState().reset();
      if (reason === 'replacement') {
        mockFetchUsage.mockResolvedValueOnce(cachedUsage);
        await store.getState().load(true);
      }
      const beforeFailure = store.getState();
      const failure = new ApiError('Old request', 401);
      oldRequest.reject(failure);
      await expect(oldLoad).resolves.toEqual(
        platform === 'ios'
          ? { status: 'failed', error: failure, usage: beforeFailure.usage }
          : { status: 'stale', usage: beforeFailure.usage },
      );
      expect(store.getState()).toBe(beforeFailure);
    },
  );

  it('keeps a newer pending request loading when the old one fails', async () => {
    const first = deferred(),
      second = deferred();
    mockFetchUsage.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const oldLoad = store.getState().load(true);
    const newLoad = store.getState().load(true);
    first.reject(new Error('Old request'));
    await expect(oldLoad).resolves.toMatchObject({
      status: platform === 'ios' ? 'failed' : 'stale',
    });
    expect(store.getState().isLoading).toBe(true);
    second.resolve(cachedUsage);
    await expect(newLoad).resolves.toMatchObject({ status: 'loaded', usage: cachedUsage });
  });

  it('preserves the platform response to a current rejected session without changing auth', async () => {
    mockFetchUsage.mockResolvedValueOnce(cachedUsage);
    await store.getState().load(true);
    const account = mockAuth;
    mockFetchUsage.mockRejectedValueOnce(new ApiError('Rejected session', 401));
    await expect(store.getState().load(true)).resolves.toMatchObject({
      status: 'failed',
      usage: platform === 'ios' ? cachedUsage : null,
    });
    expect(store.getState().isLoading).toBe(false);
    expect(mockAuth).toBe(account);
  });
});

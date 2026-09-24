import AsyncStorage from '@react-native-async-storage/async-storage';
import { useAffiliateStore } from '../useAffiliateStore';
import { useAuthStore } from '../useAuthStore';
import { useConfigStore } from '../useConfigStore';
import { getAffiliateClientConfig } from '@/lib/affiliateLink';
import { checkAndClaimAffiliate } from '@/lib/affiliateAttribution';

jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn(),
  setItem: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../useAuthStore', () => ({ useAuthStore: { getState: jest.fn() } }));
jest.mock('../useConfigStore', () => ({ useConfigStore: { getState: jest.fn() } }));
jest.mock('@/lib/affiliateLink', () => ({ getAffiliateClientConfig: jest.fn() }));
jest.mock('@/lib/affiliateAttribution', () => ({
  checkAndClaimAffiliate: jest.fn(),
  AffiliateConsentError: class AffiliateConsentError extends Error {},
}));
jest.mock('@/lib/apiClient', () => ({ ApiError: class ApiError extends Error {} }));

const claim = jest.mocked(checkAndClaimAffiliate);
let auth: { user: { id: string } | null; sessionCookie: string | null; isInitialized: boolean };
let config: { usageAnalyticsEnabled: boolean };
beforeEach(async () => {
  jest.clearAllMocks();
  jest
    .mocked(getAffiliateClientConfig)
    .mockReturnValue({ domain: 'sandbox.dub.link', publishableKey: 'dub_pk_test' });
  auth = { user: { id: 'anonymous-a' }, sessionCookie: 'session-a', isInitialized: true };
  config = { usageAnalyticsEnabled: true };
  jest
    .mocked(useAuthStore.getState)
    .mockImplementation(() => auth as ReturnType<typeof useAuthStore.getState>);
  jest
    .mocked(useConfigStore.getState)
    .mockImplementation(() => ({ config }) as ReturnType<typeof useConfigStore.getState>);
  useAffiliateStore.setState({
    ownerId: 'anonymous-a',
    link: '',
    clickId: null,
    saved: false,
    autoSubmit: false,
    hydrated: true,
    checking: false,
    error: null,
  });
  claim.mockResolvedValue('provisional');
});

it('ordinary continuation performs no affiliate request', async () => {
  expect(await useAffiliateStore.getState().prepare()).toBe(true);
  expect(claim).not.toHaveBeenCalled();
});
it('a manual paste is saved locally but only the main CTA claims it', async () => {
  await useAffiliateStore.getState().edit('https://sandbox.dub.link/creator');
  expect(claim).not.toHaveBeenCalled();
  expect(AsyncStorage.setItem).toHaveBeenLastCalledWith(
    expect.any(String),
    expect.stringContaining('sandbox.dub.link/creator'),
  );
  expect(await useAffiliateStore.getState().prepare()).toBe(true);
  expect(useAffiliateStore.getState().saved).toBe(true);
  expect(claim.mock.calls[0][2]).toBe('session-a');
});
it('checking twice makes one claim and an offline failure retains input for retry or clearing', async () => {
  let reject!: (error: Error) => void;
  claim.mockImplementation(
    () =>
      new Promise((_, fail) => {
        reject = fail;
      }),
  );
  await useAffiliateStore.getState().edit('https://sandbox.dub.link/creator');
  const first = useAffiliateStore.getState().prepare();
  await Promise.resolve();
  expect(await useAffiliateStore.getState().prepare()).toBe(false);
  reject(new Error('offline'));
  expect(await first).toBe(false);
  expect(claim).toHaveBeenCalledTimes(1);
  expect(useAffiliateStore.getState().link).toContain('/creator');
  expect(useAffiliateStore.getState().error).toContain('clear the field');
  await useAffiliateStore.getState().edit('');
  expect(await useAffiliateStore.getState().prepare()).toBe(true);
});
it('a previous account response cannot claim or persist for the next account', async () => {
  let finish!: (status: 'provisional') => void;
  claim.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await useAffiliateStore.getState().edit('https://sandbox.dub.link/creator');
  const pending = useAffiliateStore.getState().prepare();
  await new Promise<void>((resolve) => setImmediate(resolve));
  auth = { ...auth, user: { id: 'account-b' }, sessionCookie: 'session-b' };
  await useAffiliateStore.getState().bindSession();
  expect(claim.mock.calls[0][3]()).toBe(false);
  finish('provisional');
  expect(await pending).toBe(false);
  expect(useAffiliateStore.getState()).toMatchObject({
    ownerId: 'account-b',
    link: '',
    saved: false,
    checking: false,
  });
});
it('signout clears a saved referral and hydration cannot restore another account’s candidate', async () => {
  useAffiliateStore.setState({ link: 'https://sandbox.dub.link/creator', saved: true });
  auth = { ...auth, user: null, sessionCookie: null };
  await useAffiliateStore.getState().bindSession();
  expect(useAffiliateStore.getState()).toMatchObject({ link: '', saved: false, ownerId: null });
  jest.mocked(AsyncStorage.getItem).mockResolvedValue(
    JSON.stringify({
      ownerId: 'old-user',
      link: 'https://sandbox.dub.link/old',
      clickId: 'click',
      saved: true,
      autoSubmit: false,
    }),
  );
  useAffiliateStore.setState({ hydrated: false });
  await useAffiliateStore.getState().hydrate();
  await useAffiliateStore.getState().bindSession();
  expect(useAffiliateStore.getState().link).toBe('');
});
it('persists the resolved click before claiming and reuses it after a failed claim', async () => {
  await useAffiliateStore.getState().edit('https://sandbox.dub.link/creator');
  claim.mockImplementationOnce(async (_link, _click, _cookie, _current, remember) => {
    await remember('click-once');
    throw new Error('claim response lost');
  });
  expect(await useAffiliateStore.getState().prepare()).toBe(false);
  expect(useAffiliateStore.getState().clickId).toBe('click-once');
  expect(await useAffiliateStore.getState().prepare()).toBe(true);
  expect(claim.mock.calls[1][1]).toBe('click-once');
});
it('analytics refusal prevents collection and review does not show saved success', async () => {
  await useAffiliateStore.getState().edit('https://sandbox.dub.link/creator');
  config.usageAnalyticsEnabled = false;
  expect(await useAffiliateStore.getState().prepare()).toBe(false);
  expect(claim).not.toHaveBeenCalled();
  config.usageAnalyticsEnabled = true;
  claim.mockResolvedValue('review');
  expect(await useAffiliateStore.getState().prepare()).toBe(false);
  expect(useAffiliateStore.getState().saved).toBe(false);
});

it('disabling affiliate configuration never blocks ordinary onboarding with a cached link', async () => {
  await useAffiliateStore.getState().edit('https://sandbox.dub.link/creator');
  jest.mocked(getAffiliateClientConfig).mockReturnValue(null);
  expect(await useAffiliateStore.getState().prepare()).toBe(true);
  expect(claim).not.toHaveBeenCalled();
});

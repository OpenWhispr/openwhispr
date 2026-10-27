import { api } from '../apiClient';
import {
  AffiliateConsentError,
  checkAndClaimAffiliate,
  requestTrackingForCreatorCode,
} from '../affiliateAttribution';
import { setAppsFlyerTrackingAuthorizationStatus } from '../appsflyer';
import {
  getTrackingAuthorizationStatus,
  requestTrackingAuthorization,
} from '../trackingTransparency';
jest.mock('../trackingTransparency', () => ({
  getTrackingAuthorizationStatus: jest.fn(),
  requestTrackingAuthorization: jest.fn(),
}));
jest.mock('../appsflyer', () => ({ setAppsFlyerTrackingAuthorizationStatus: jest.fn() }));
jest.mock('../apiClient', () => ({ api: { post: jest.fn() } }));
jest.mock('../affiliateLink', () => ({
  getAffiliateClientConfig: () => ({ domain: 'sandbox.dub.link', publishableKey: 'dub_pk_test' }),
  parseAffiliateInput: jest.requireActual('../affiliateLink').parseAffiliateInput,
}));
const link = 'https://sandbox.dub.link/creator';
const dubOpen = (body: unknown, ok = true) =>
  ({ ok, json: async () => body }) as unknown as Response;
const fetchMock = jest.fn<Promise<Response>, Parameters<typeof fetch>>();
const trackedLinks = () =>
  fetchMock.mock.calls.map(([, init]) => JSON.parse(String(init?.body)).deepLink);
beforeAll(() => {
  global.fetch = fetchMock as unknown as typeof fetch;
});
beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(getTrackingAuthorizationStatus).mockResolvedValue('authorized');
  jest.mocked(api.post).mockResolvedValue({ data: { persisted: true, status: 'provisional' } });
  fetchMock.mockResolvedValue(
    dubOpen({ clickId: 'click', link: { domain: 'sandbox.dub.link', key: 'creator' } }),
  );
});
it.each(['denied', 'notDetermined'] as const)(
  'does not resolve or claim a link when tracking is %s',
  async (status) => {
    jest.mocked(getTrackingAuthorizationStatus).mockResolvedValue(status);
    await expect(
      checkAndClaimAffiliate(link, null, 'session-a', () => true, jest.fn()),
    ).rejects.toBeInstanceOf(AffiliateConsentError);
    expect(api.post).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  },
);
it('checks with the server, resolves only the explicit URL and uses the captured session for claim', async () => {
  const remember = jest.fn().mockResolvedValue(undefined);
  expect(await checkAndClaimAffiliate(link, null, 'session-a', () => true, remember)).toBe(
    'provisional',
  );
  expect(fetchMock).toHaveBeenCalledWith(
    'https://api.dub.co/track/open',
    expect.objectContaining({
      method: 'POST',
      headers: expect.objectContaining({ Authorization: 'Bearer dub_pk_test' }),
      body: JSON.stringify({ dubDomain: 'sandbox.dub.link', deepLink: link }),
      signal: expect.any(AbortSignal),
    }),
  );
  expect(remember).toHaveBeenCalledWith('click');
  expect(api.post).toHaveBeenNthCalledWith(
    2,
    '/api/affiliate/claim',
    { link, clickId: 'click', source: 'mobile' },
    expect.objectContaining({ authenticated: false, headers: { Cookie: 'session-a' } }),
  );
});
it('invalid/expired server checks never create a click or claim', async () => {
  jest.mocked(api.post).mockRejectedValueOnce(new Error('expired'));
  await expect(
    checkAndClaimAffiliate(link, null, 'session-a', () => true, jest.fn()),
  ).rejects.toThrow('expired');
  expect(fetchMock).not.toHaveBeenCalled();
  expect(api.post).toHaveBeenCalledTimes(1);
});
it('account switch during resolution never sends a claim with the new session', async () => {
  let current = true;
  fetchMock.mockImplementation(async () => {
    current = false;
    return dubOpen({ clickId: 'click', link: { domain: 'sandbox.dub.link', key: 'creator' } });
  });
  await expect(
    checkAndClaimAffiliate(link, null, 'session-a', () => current, jest.fn()),
  ).rejects.toThrow('interrupted');
  expect(api.post).toHaveBeenCalledTimes(1);
});
it('a hung Dub request cannot leave the CTA checking forever', async () => {
  jest.useFakeTimers();
  fetchMock.mockImplementation(() => new Promise(() => {}));
  const pending = checkAndClaimAffiliate(link, null, 'session-a', () => true, jest.fn());
  const result = pending.catch((error: Error) => error);
  await jest.advanceTimersByTimeAsync(10001);
  expect(await result).toEqual(new Error('Referral check interrupted. Try again.'));
  expect(api.post).toHaveBeenCalledTimes(1);
  jest.useRealTimers();
});

it('a hung native permission read releases the CTA without starting attribution', async () => {
  jest.useFakeTimers();
  jest.mocked(getTrackingAuthorizationStatus).mockImplementation(() => new Promise(() => {}));
  const result = checkAndClaimAffiliate(link, null, 'session-a', () => true, jest.fn()).catch(
    (error: Error) => error,
  );
  await jest.advanceTimersByTimeAsync(10001);
  expect(await result).toEqual(new Error('Referral check interrupted. Try again.'));
  expect(api.post).not.toHaveBeenCalled();
  expect(fetchMock).not.toHaveBeenCalled();
  jest.useRealTimers();
});

it('stops before Dub if tracking is revoked while validating the link', async () => {
  jest.mocked(api.post).mockImplementationOnce(async () => {
    jest.mocked(getTrackingAuthorizationStatus).mockResolvedValue('denied');
    return { data: { valid: true } };
  });
  await expect(
    checkAndClaimAffiliate(link, null, 'session-a', () => true, jest.fn()),
  ).rejects.toBeInstanceOf(AffiliateConsentError);
  expect(fetchMock).not.toHaveBeenCalled();
  expect(api.post).toHaveBeenCalledTimes(1);
});

it('an explicit short-code submission uses the exact trusted full link', async () => {
  await checkAndClaimAffiliate('creator', null, 'session-a', () => true, jest.fn());
  expect(trackedLinks()).toEqual([link]);
  expect(api.post).toHaveBeenNthCalledWith(
    1,
    '/api/affiliate/check-link',
    { link },
    expect.any(Object),
  );
});
it('ambiguous short-code case never reaches tracking or claim', async () => {
  await expect(
    checkAndClaimAffiliate('Creator', null, 'session-a', () => true, jest.fn()),
  ).rejects.toThrow();
  expect(fetchMock).not.toHaveBeenCalled();
  expect(api.post).not.toHaveBeenCalled();
});

it('asks iOS for tracking on an explicit creator submission only while undecided', async () => {
  jest.mocked(getTrackingAuthorizationStatus).mockResolvedValueOnce('notDetermined');
  jest.mocked(requestTrackingAuthorization).mockResolvedValueOnce('authorized');
  await requestTrackingForCreatorCode();
  expect(setAppsFlyerTrackingAuthorizationStatus).toHaveBeenCalledWith('authorized');
  for (const status of ['denied', 'authorized', 'notSupported'] as const) {
    jest.mocked(getTrackingAuthorizationStatus).mockResolvedValueOnce(status);
    await requestTrackingForCreatorCode();
  }
  expect(requestTrackingAuthorization).toHaveBeenCalledTimes(1);
});

it('reports a claim the server accepted even if the caller stopped waiting', async () => {
  let current = true;
  jest.mocked(api.post).mockImplementation(async (path: string) => {
    if (path !== '/api/affiliate/claim') return { data: {} };
    await Promise.resolve();
    current = false;
    return { data: { persisted: true, status: 'registered' } };
  });
  await expect(
    checkAndClaimAffiliate(link, null, 'session-a', () => current, jest.fn()),
  ).resolves.toBe('registered');
});

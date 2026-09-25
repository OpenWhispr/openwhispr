import dub from '@dub/react-native';
import { api } from '../apiClient';
import { AffiliateConsentError, checkAndClaimAffiliate } from '../affiliateAttribution';
import { getTrackingAuthorizationStatus } from '../trackingTransparency';
jest.mock('../trackingTransparency', () => ({ getTrackingAuthorizationStatus: jest.fn() }));
jest.mock('@dub/react-native', () => ({ init: jest.fn(), trackOpen: jest.fn() }));
jest.mock('../apiClient', () => ({ api: { post: jest.fn() } }));
jest.mock('../affiliateLink', () => ({
  getAffiliateClientConfig: () => ({ domain: 'sandbox.dub.link', publishableKey: 'dub_pk_test' }),
  parseAffiliateInput: jest.requireActual('../affiliateLink').parseAffiliateInput,
}));
const link = 'https://sandbox.dub.link/creator';
beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(getTrackingAuthorizationStatus).mockResolvedValue('authorized');
  jest.mocked(api.post).mockResolvedValue({ data: { persisted: true, status: 'provisional' } });
  jest.mocked(dub.trackOpen).mockResolvedValue({
    clickId: 'click',
    link: { domain: 'sandbox.dub.link', key: 'creator' },
  } as Awaited<ReturnType<typeof dub.trackOpen>>);
});
it.each(['denied', 'notDetermined'] as const)(
  'does not resolve or claim a link when tracking is %s',
  async (status) => {
    jest.mocked(getTrackingAuthorizationStatus).mockResolvedValue(status);
    await expect(
      checkAndClaimAffiliate(link, null, 'session-a', () => true, jest.fn()),
    ).rejects.toBeInstanceOf(AffiliateConsentError);
    expect(api.post).not.toHaveBeenCalled();
    expect(dub.trackOpen).not.toHaveBeenCalled();
  },
);
it('checks with the server, resolves only the explicit URL and uses the captured session for claim', async () => {
  const remember = jest.fn().mockResolvedValue(undefined);
  expect(await checkAndClaimAffiliate(link, null, 'session-a', () => true, remember)).toBe(
    'provisional',
  );
  expect(dub.trackOpen).toHaveBeenCalledWith(link);
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
  expect(dub.trackOpen).not.toHaveBeenCalled();
  expect(api.post).toHaveBeenCalledTimes(1);
});
it('account switch during resolution never sends a claim with the new session', async () => {
  let current = true;
  jest.mocked(dub.trackOpen).mockImplementation(async () => {
    current = false;
    return { clickId: 'click', link: { domain: 'sandbox.dub.link', key: 'creator' } } as Awaited<
      ReturnType<typeof dub.trackOpen>
    >;
  });
  await expect(
    checkAndClaimAffiliate(link, null, 'session-a', () => current, jest.fn()),
  ).rejects.toThrow('interrupted');
  expect(api.post).toHaveBeenCalledTimes(1);
});
it('a hung SDK cannot leave the CTA checking forever', async () => {
  jest.useFakeTimers();
  jest.mocked(dub.trackOpen).mockImplementation(() => new Promise(() => {}));
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
  expect(dub.trackOpen).not.toHaveBeenCalled();
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
  expect(dub.init).not.toHaveBeenCalled();
  expect(dub.trackOpen).not.toHaveBeenCalled();
  expect(api.post).toHaveBeenCalledTimes(1);
});

it('an explicit short-code submission uses the exact trusted full link', async () => {
  await checkAndClaimAffiliate('creator', null, 'session-a', () => true, jest.fn());
  expect(dub.trackOpen).toHaveBeenCalledWith(link);
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
  expect(dub.trackOpen).not.toHaveBeenCalled();
  expect(api.post).not.toHaveBeenCalled();
});

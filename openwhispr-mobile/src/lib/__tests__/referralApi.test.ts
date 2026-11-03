// referralApi builds its own headers (not through apiRequest) but shares the
// centralized getClientVersionHeader() from apiClient, which reads
// Constants.expoConfig?.version and imports expo/fetch + useAuthStore
// transitively — mock all three so the import chain resolves in tests.
type ReferralApiModule = typeof import('../referralApi');

function loadReferralApi(
  version: string | undefined,
  platform: 'ios' | 'android' = 'ios',
): {
  referralApi: ReferralApiModule;
  mockFetch: jest.Mock;
} {
  jest.resetModules();
  jest.doMock('react-native', () => ({ Platform: { OS: platform } }));
  const mockFetch = jest.fn();
  jest.doMock('expo/fetch', () => ({
    __esModule: true,
    fetch: mockFetch,
  }));
  jest.doMock('expo-constants', () => ({
    __esModule: true,
    default: { expoConfig: version === undefined ? {} : { version } },
  }));
  jest.doMock('@/store/useAuthStore', () => ({
    useAuthStore: { getState: () => ({ sessionCookie: null }) },
  }));

  const referralApi = require('../referralApi') as ReferralApiModule;
  return { referralApi, mockFetch };
}

afterEach(() => {
  jest.dontMock('react-native');
  jest.dontMock('expo/fetch');
  jest.dontMock('expo-constants');
  jest.dontMock('@/store/useAuthStore');
  jest.resetModules();
});

it.each(['android', 'ios'] as const)(
  'keeps referral session headers authoritative on %s',
  async (platform) => {
    const { referralApi, mockFetch } = loadReferralApi('1.2.4', platform);
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ invites: [] }) });
    const cookie = 'openwhispr.session_token=current-account';
    await referralApi.fetchReferralStats(cookie);
    await referralApi.fetchReferralInvites(null);
    await referralApi.sendReferralInvite('synthetic@example.invalid', cookie);

    for (const [, init] of mockFetch.mock.calls) {
      expect(init.credentials).toBe(platform === 'android' ? 'omit' : undefined);
    }
    expect(mockFetch.mock.calls.map(([, init]) => init.headers.Cookie)).toEqual([
      cookie,
      undefined,
      cookie,
    ]);
  },
);

describe('referralApi client version header', () => {
  it('sends x-openwhispr-version on the stats request when the app version is known', async () => {
    const { referralApi, mockFetch } = loadReferralApi('3.1.4');
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        referralCode: 'x',
        referralLink: 'y',
        totalReferrals: 0,
        completedReferrals: 0,
        totalMonthsEarned: 0,
        referrals: [],
      }),
    });

    await referralApi.fetchReferralStats(null);

    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers['x-openwhispr-version']).toBe('3.1.4');
  });

  it('omits x-openwhispr-version when the app version is unknown', async () => {
    const { referralApi, mockFetch } = loadReferralApi(undefined);
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ invites: [] }) });

    await referralApi.fetchReferralInvites(null);

    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers).not.toHaveProperty('x-openwhispr-version');
  });
});

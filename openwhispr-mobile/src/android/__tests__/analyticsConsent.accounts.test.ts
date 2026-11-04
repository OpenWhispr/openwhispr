import type { UserConfig } from '@/types';
import type { AuthUser } from '@/lib/authClient';

let mockStoredConfig: UserConfig;
let mockSessionReady: (() => void) | undefined;
const mockSaveConfig = jest.fn(async (config: UserConfig) => {
  mockStoredConfig = { ...config };
});
const mockSignIn = jest.fn();
const mockInit = jest.fn(async () => {});
const mockStart = jest.fn(async () => {});
const mockStop = jest.fn(async () => {});
const mockLogEvent = jest.fn(async () => {});

jest.mock('react-native', () => ({ Platform: { OS: 'android' } }));
jest.mock('expo-tracking-transparency', () => ({ isAvailable: () => false }));
jest.mock('expo-secure-store', () => ({
  getItemAsync: async () => null,
  setItemAsync: async () => {},
  deleteItemAsync: async () => {},
}));
jest.mock('@/services/storage/StorageService', () => ({
  StorageService: {
    getConfig: async () => ({ ...mockStoredConfig }),
    saveConfig: (config: UserConfig) => mockSaveConfig(config),
  },
}));
jest.mock('@/store/useProcessingModeStore', () => ({
  useProcessingModeStore: { getState: () => ({ resetToDefault: jest.fn() }) },
}));
jest.mock('@/lib/authClient', () => ({
  signInWithEmail: (email: string, password: string) => mockSignIn(email, password),
  signOut: async () => {},
  clearSession: async () => {},
  initAuthenticatedUser: async () => {},
}));
jest.mock('@/android/accountData', () => ({ prepareAccountData: jest.fn() }));
jest.mock('@/store/useUsageStore', () => ({
  useUsageStore: { getState: () => ({ reset: jest.fn() }) },
}));
jest.mock('@/services/agent/AgentComposerService', () => ({ clearAllSessions: jest.fn() }));
jest.mock('@/lib/notes/noteShareTokens', () => ({ claimNoteShareTokens: async () => {} }));
jest.mock('@/lib/sentry', () => ({ Sentry: { captureException: jest.fn() } }));
jest.mock('react-native-appsflyer', () => ({
  __esModule: true,
  default: {
    init: mockInit,
    enableDebug: async () => {},
    registerSessionReadyListener: async (listener: () => void) => {
      mockSessionReady = listener;
    },
    start: mockStart,
    stop: mockStop,
    logEvent: mockLogEvent,
  },
}));

const originalDevKey = process.env.EXPO_PUBLIC_APPSFLYER_DEV_KEY;
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
let config: typeof import('@/store/useConfigStore').useConfigStore;
let auth: typeof import('@/store/useAuthStore').useAuthStore;
let appsFlyer: typeof import('@/lib/appsflyer');

beforeEach(() => {
  jest.resetModules();
  jest.clearAllMocks();
  mockSessionReady = undefined;
  mockSaveConfig.mockReset().mockImplementation(async (value) => {
    mockStoredConfig = { ...value };
  });
  process.env.EXPO_PUBLIC_APPSFLYER_DEV_KEY = 'fixture-only';
  mockStoredConfig = {
    defaultMode: 'cloud',
    localModeUpgraded: true,
    noteChatSplit: true,
    notesLocalModeSplit: true,
    usageAnalyticsEnabled: false,
  };
  config = require('@/store/useConfigStore').useConfigStore;
  auth = require('@/store/useAuthStore').useAuthStore;
  appsFlyer = require('@/lib/appsflyer');
});

afterAll(() => {
  if (originalDevKey === undefined) delete process.env.EXPO_PUBLIC_APPSFLYER_DEV_KEY;
  else process.env.EXPO_PUBLIC_APPSFLYER_DEV_KEY = originalDevKey;
});

async function signIn(id: 'account-a' | 'account-b'): Promise<void> {
  const user: AuthUser = {
    id,
    email: `${id}@example.invalid`,
    emailVerified: true,
    isAnonymous: false,
  };
  mockSignIn.mockResolvedValueOnce({ user, sessionCookie: `fixture=${id}`, error: null });
  await auth.getState().signIn(user.email, 'fixture-password');
  expect(auth.getState().user?.id).toBe(id);
  expect(auth.getState().isGuest).toBe(false);
}

async function replaceAccountWhileOptedOut(): Promise<void> {
  await auth.getState().signOut();
  expect(auth.getState().user).toBeNull();
  appsFlyer.logAppsFlyerEvent('signed_out');
  await auth.getState().continueAsGuest();
  expect(auth.getState().isGuest).toBe(true);
  appsFlyer.logAppsFlyerEvent('local_mode');
  await signIn('account-b');
  appsFlyer.logAppsFlyerEvent('account_b');
  await flush();
  expect(config.getState().config?.usageAnalyticsEnabled).toBe(false);
  expect(appsFlyer.getAppsFlyerAttributionConsent()).toBe('revoked');
}

it('keeps persisted device opt-out through A, sign-out, local mode and B without initializing native', async () => {
  appsFlyer.initAppsFlyer();
  await flush();
  expect(mockInit).not.toHaveBeenCalled();
  await config.getState().loadConfig();
  await signIn('account-a');
  appsFlyer.logAppsFlyerEvent('account_a');
  await replaceAccountWhileOptedOut();
  await config.getState().loadConfig();

  expect(mockInit).not.toHaveBeenCalled();
  expect(mockStart).not.toHaveBeenCalled();
  expect(mockLogEvent).not.toHaveBeenCalled();
  expect(mockStoredConfig.usageAnalyticsEnabled).toBe(false);
});

it.each(['saved', 'failed'] as const)(
  'keeps withdrawal authoritative across account replacement while persistence is pending and then %s',
  async (outcome) => {
    mockStoredConfig.usageAnalyticsEnabled = true;
    await config.getState().loadConfig();
    await signIn('account-a');
    appsFlyer.initAppsFlyer();
    await flush();
    mockSessionReady?.();
    await flush();
    appsFlyer.logAppsFlyerEvent('enabled_account_a');
    await flush();
    expect(mockLogEvent).toHaveBeenCalledWith({
      eventName: 'enabled_account_a',
      eventValues: {},
    });
    mockLogEvent.mockClear();

    let finishSave!: () => void;
    let failSave!: (error: Error) => void;
    mockSaveConfig.mockImplementationOnce(
      (value) =>
        new Promise<void>((resolve, reject) => {
          finishSave = () => {
            mockStoredConfig = { ...value };
            resolve();
          };
          failSave = reject;
        }),
    );
    const withdrawal = config.getState().updateConfig({ usageAnalyticsEnabled: false });
    expect(mockStop).toHaveBeenCalledWith({ shouldStop: true });
    await replaceAccountWhileOptedOut();
    expect(mockLogEvent).not.toHaveBeenCalled();
    expect(mockStop.mock.calls).toEqual([[{ shouldStop: true }]]);

    if (outcome === 'saved') finishSave();
    else failSave(new Error('disk full'));
    await withdrawal;
    await config.getState().loadConfig();
    expect(config.getState().config?.usageAnalyticsEnabled).toBe(false);
    expect(config.getState().error).toBe(outcome === 'saved' ? null : 'disk full');
    appsFlyer.logAppsFlyerEvent('after_account_b_reload');
    await flush();
    expect(mockLogEvent).not.toHaveBeenCalled();

    await config.getState().updateConfig({ usageAnalyticsEnabled: true });
    await flush();
    expect(auth.getState().user?.id).toBe('account-b');
    expect(mockStoredConfig.usageAnalyticsEnabled).toBe(true);
    expect(mockStop.mock.calls).toEqual([[{ shouldStop: true }], [{ shouldStop: false }]]);
    appsFlyer.logAppsFlyerEvent('explicit_account_b_opt_in');
    await flush();
    expect(mockLogEvent.mock.calls).toEqual([
      [{ eventName: 'explicit_account_b_opt_in', eventValues: {} }],
    ]);
  },
);

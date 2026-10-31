import type { ReactNativeOptions } from '@sentry/react-native';

const mockSaveConfig = jest.fn();
const mockGetConfig = jest.fn();
const mockAppsFlyerInit = jest.fn(() => Promise.resolve());
const mockStart = jest.fn(() => Promise.resolve());
const mockStop = jest.fn(() => Promise.resolve());
const mockLogEvent = jest.fn(() => Promise.resolve());
const mockSentryInit = jest.fn<void, [ReactNativeOptions]>();
const mockSentryClose = jest.fn(() => Promise.resolve(true));
let mockSessionReady: (() => void) | undefined;

jest.mock('react-native', () => ({ Platform: { OS: 'android' } }));
jest.mock('@/services/storage/StorageService', () => ({
  StorageService: {
    saveConfig: (config: unknown) => mockSaveConfig(config),
    getConfig: () => mockGetConfig(),
  },
}));
jest.mock('@/store/useProcessingModeStore', () => ({
  useProcessingModeStore: { getState: () => ({ resetToDefault: jest.fn() }) },
}));
jest.mock('@/lib/trackingTransparency', () => ({
  getTrackingAuthorizationStatus: () => Promise.resolve('notSupported'),
}));
jest.mock('react-native-appsflyer', () => ({
  __esModule: true,
  default: {
    init: mockAppsFlyerInit,
    enableDebug: () => Promise.resolve(),
    registerSessionReadyListener: (listener: () => void) => {
      mockSessionReady = listener;
      return Promise.resolve();
    },
    start: mockStart,
    stop: mockStop,
    logEvent: mockLogEvent,
  },
}));
jest.mock('@sentry/react-native', () => ({
  init: mockSentryInit,
  close: mockSentryClose,
  mobileReplayIntegration: () => ({ name: 'MobileReplay' }),
}));

const originalDevKey = process.env.EXPO_PUBLIC_APPSFLYER_DEV_KEY;
const originalDsn = process.env.EXPO_PUBLIC_SENTRY_DSN;
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

beforeEach(() => {
  jest.resetModules();
  jest.clearAllMocks();
  mockSessionReady = undefined;
  process.env.EXPO_PUBLIC_APPSFLYER_DEV_KEY = 'fixture-only';
  process.env.EXPO_PUBLIC_SENTRY_DSN = 'https://fixture@example.invalid/1';
});

afterAll(() => {
  if (originalDevKey === undefined) delete process.env.EXPO_PUBLIC_APPSFLYER_DEV_KEY;
  else process.env.EXPO_PUBLIC_APPSFLYER_DEV_KEY = originalDevKey;
  if (originalDsn === undefined) delete process.env.EXPO_PUBLIC_SENTRY_DSN;
  else process.env.EXPO_PUBLIC_SENTRY_DSN = originalDsn;
});

it.each(['resolve', 'reject'] as const)(
  'withdraws through the real store and subscribers while storage is pending, then %ss',
  async (outcome) => {
    const { useConfigStore } =
      require('@/store/useConfigStore') as typeof import('@/store/useConfigStore');
    const appsFlyer = require('../appsflyer') as typeof import('../appsflyer');
    const sentry = require('../sentry') as typeof import('../sentry');
    useConfigStore.setState({ config: { defaultMode: 'cloud', usageAnalyticsEnabled: true } });
    sentry.initSentry();
    appsFlyer.initAppsFlyer();
    await flush();
    mockSessionReady?.();
    await flush();
    expect(mockStart).toHaveBeenCalledTimes(1);
    expect(mockSentryInit).toHaveBeenCalledTimes(1);
    appsFlyer.logAppsFlyerEvent('enabled_control');
    await flush();
    expect(mockLogEvent).toHaveBeenCalledWith({ eventName: 'enabled_control', eventValues: {} });
    mockLogEvent.mockClear();

    let resolve!: () => void;
    let reject!: (error: Error) => void;
    mockSaveConfig.mockReturnValueOnce(
      new Promise<void>((done, fail) => {
        resolve = done;
        reject = fail;
      }),
    );
    const update = useConfigStore.getState().updateConfig({ usageAnalyticsEnabled: false });
    try {
      expect(mockStop).toHaveBeenCalledWith({ shouldStop: true });
      expect(mockSentryClose).toHaveBeenCalledTimes(1);
      expect(
        mockSentryInit.mock.calls[0][0].beforeSend?.({ type: undefined, event_id: 'blocked' }, {}),
      ).toBeNull();
      appsFlyer.logAppsFlyerEvent('withdrawn_while_saving');
      await flush();
      expect(mockLogEvent).not.toHaveBeenCalled();
      expect(mockSentryInit).toHaveBeenCalledTimes(1);
    } finally {
      if (outcome === 'resolve') resolve();
      else reject(new Error('disk full'));
      await update;
    }
    mockGetConfig.mockResolvedValue({
      defaultMode: 'cloud',
      usageAnalyticsEnabled: true,
      localModeUpgraded: true,
      noteChatSplit: true,
      notesLocalModeSplit: true,
    });
    await useConfigStore.getState().loadConfig();
    expect(useConfigStore.getState().error).toBe(outcome === 'reject' ? 'disk full' : null);
    appsFlyer.logAppsFlyerEvent('withdrawn_after_save');
    await flush();
    expect(mockLogEvent).not.toHaveBeenCalled();
    expect(mockStart).toHaveBeenCalledTimes(1);
    expect(mockSentryInit).toHaveBeenCalledTimes(1);
  },
);

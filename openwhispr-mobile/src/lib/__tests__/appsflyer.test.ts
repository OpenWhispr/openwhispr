import type { UserConfig } from '@/types';
import type { TrackingAuthorizationStatus } from '@/lib/trackingTransparency';

type AppsFlyerModule = typeof import('../appsflyer');

interface MockConfigState {
  config: UserConfig | null;
  isLoading: boolean;
}

let mockSessionReadyListener: (() => void) | undefined;
let mockConfigState: MockConfigState = { config: null, isLoading: false };
const mockConfigListeners = new Set<() => void>();

const mockInit = jest.fn((): Promise<void> => Promise.resolve());
const mockEnableDebug = jest.fn((): Promise<void> => Promise.resolve());
const mockRegisterSessionReadyListener = jest.fn((listener: () => void): Promise<void> => {
  mockSessionReadyListener = listener;
  return Promise.resolve();
});
const mockStart = jest.fn((): Promise<void> => Promise.resolve());
const mockStop = jest.fn((): Promise<void> => Promise.resolve());
const mockLogEvent = jest.fn((): Promise<void> => Promise.resolve());
const mockGetTrackingAuthorizationStatus = jest.fn<Promise<TrackingAuthorizationStatus>, []>(() =>
  Promise.resolve('authorized'),
);
const mockGetConfigState = jest.fn((): MockConfigState => mockConfigState);
const mockSubscribeToConfig = jest.fn((listener: () => void): (() => void) => {
  mockConfigListeners.add(listener);
  return (): void => {
    mockConfigListeners.delete(listener);
  };
});

const mockUseConfigStore = {
  getState: mockGetConfigState,
  subscribe: mockSubscribeToConfig,
};

jest.mock('react-native-appsflyer', () => ({
  __esModule: true,
  default: {
    init: mockInit,
    enableDebug: mockEnableDebug,
    registerSessionReadyListener: mockRegisterSessionReadyListener,
    start: mockStart,
    stop: mockStop,
    logEvent: mockLogEvent,
  },
}));

jest.mock('@/store/useConfigStore', () => ({
  useConfigStore: mockUseConfigStore,
}));

jest.mock('@/lib/trackingTransparency', () => ({
  getTrackingAuthorizationStatus: (): Promise<TrackingAuthorizationStatus> =>
    mockGetTrackingAuthorizationStatus(),
}));

function loadAppsFlyer(): AppsFlyerModule {
  jest.resetModules();
  return require('../appsflyer') as AppsFlyerModule;
}

function setConfigState(state: MockConfigState): void {
  mockConfigState = state;
  mockConfigListeners.forEach((listener) => listener());
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function flushPromises(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

async function loadInitializedAppsFlyer(): Promise<AppsFlyerModule> {
  const appsFlyer = loadAppsFlyer();
  appsFlyer.initAppsFlyer();
  setConfigState({
    config: { defaultMode: 'cloud', usageAnalyticsEnabled: true },
    isLoading: false,
  });
  await flushPromises();
  return appsFlyer;
}

async function loadStartedAppsFlyer(): Promise<AppsFlyerModule> {
  const appsFlyer = await loadInitializedAppsFlyer();
  mockSessionReadyListener?.();
  await flushPromises();
  return appsFlyer;
}

const originalDevKey = process.env.EXPO_PUBLIC_APPSFLYER_DEV_KEY;

beforeEach(() => {
  process.env.EXPO_PUBLIC_APPSFLYER_DEV_KEY = 'test-dev-key';
  mockSessionReadyListener = undefined;
  mockConfigState = { config: null, isLoading: false };
  mockConfigListeners.clear();
  jest.clearAllMocks();
  mockInit.mockReset().mockResolvedValue(undefined);
  mockEnableDebug.mockReset().mockResolvedValue(undefined);
  mockRegisterSessionReadyListener.mockReset().mockImplementation((listener: () => void) => {
    mockSessionReadyListener = listener;
    return Promise.resolve();
  });
  mockStart.mockReset().mockResolvedValue(undefined);
  mockStop.mockReset().mockResolvedValue(undefined);
  mockLogEvent.mockReset().mockResolvedValue(undefined);
  mockGetTrackingAuthorizationStatus.mockReset().mockResolvedValue('authorized');
  jest.spyOn(console, 'warn').mockImplementation((): void => undefined);
});

afterEach(() => {
  jest.restoreAllMocks();
});

afterAll(() => {
  if (originalDevKey === undefined) {
    delete process.env.EXPO_PUBLIC_APPSFLYER_DEV_KEY;
  } else {
    process.env.EXPO_PUBLIC_APPSFLYER_DEV_KEY = originalDevKey;
  }
});

describe('AppsFlyer lifecycle', () => {
  it('stays disabled and warns once when the dev key is missing', () => {
    delete process.env.EXPO_PUBLIC_APPSFLYER_DEV_KEY;
    const appsFlyer = loadAppsFlyer();

    appsFlyer.initAppsFlyer();
    appsFlyer.initAppsFlyer();
    setConfigState({
      config: { defaultMode: 'cloud', usageAnalyticsEnabled: true },
      isLoading: false,
    });

    expect(mockInit).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalledTimes(1);
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining('EXPO_PUBLIC_APPSFLYER_DEV_KEY'),
    );
  });

  it('does not initialize before config hydration or for a persisted opt-out', async () => {
    const appsFlyer = loadAppsFlyer();

    appsFlyer.initAppsFlyer();
    await flushPromises();
    expect(mockInit).not.toHaveBeenCalled();

    setConfigState({
      config: { defaultMode: 'cloud', usageAnalyticsEnabled: false },
      isLoading: false,
    });

    expect(mockInit).not.toHaveBeenCalled();
  });

  it('initializes after hydration when usage analytics use the enabled default', async () => {
    const appsFlyer = loadAppsFlyer();

    appsFlyer.initAppsFlyer();
    expect(mockInit).not.toHaveBeenCalled();

    setConfigState({
      config: { defaultMode: 'cloud' },
      isLoading: false,
    });
    await flushPromises();

    expect(mockInit).toHaveBeenCalledWith({
      devKey: 'test-dev-key',
      appId: '6763804420',
    });
    expect(mockRegisterSessionReadyListener).toHaveBeenCalledTimes(1);
  });

  it('waits for initialization before sending an event', async () => {
    const initialization = deferred<void>();
    mockInit.mockReturnValueOnce(initialization.promise);
    const appsFlyer = loadAppsFlyer();

    appsFlyer.initAppsFlyer();
    setConfigState({
      config: { defaultMode: 'cloud', usageAnalyticsEnabled: true },
      isLoading: false,
    });
    await flushPromises();
    appsFlyer.logAppsFlyerEvent('af_trial_started');

    expect(mockLogEvent).not.toHaveBeenCalled();

    initialization.resolve();
    await flushPromises();

    expect(mockLogEvent).not.toHaveBeenCalled();

    mockSessionReadyListener?.();
    await flushPromises();

    expect(mockLogEvent).toHaveBeenCalledWith({
      eventName: 'af_trial_started',
      eventValues: {},
    });
  });

  it('waits for the current session to start before sending an event', async () => {
    const sessionStart = deferred<void>();
    mockStart.mockReturnValueOnce(sessionStart.promise);
    const appsFlyer = loadAppsFlyer();

    appsFlyer.initAppsFlyer();
    setConfigState({
      config: { defaultMode: 'cloud', usageAnalyticsEnabled: true },
      isLoading: false,
    });
    await flushPromises();

    appsFlyer.logAppsFlyerEvent('af_trial_started');
    await flushPromises();

    expect(mockLogEvent).not.toHaveBeenCalled();

    mockSessionReadyListener?.();
    await flushPromises();
    expect(mockStart).toHaveBeenCalledTimes(1);
    expect(mockLogEvent).not.toHaveBeenCalled();

    sessionStart.resolve();
    await flushPromises();

    expect(mockLogEvent).toHaveBeenCalledWith({
      eventName: 'af_trial_started',
      eventValues: {},
    });
  });

  it('rechecks ATT before starting a supported iOS session', async () => {
    const appsFlyer = await loadInitializedAppsFlyer();
    const sessionAuthorization = deferred<TrackingAuthorizationStatus>();
    mockGetTrackingAuthorizationStatus.mockReturnValueOnce(sessionAuthorization.promise);

    mockSessionReadyListener?.();

    expect(mockGetTrackingAuthorizationStatus).toHaveBeenCalledTimes(2);
    expect(mockStart).not.toHaveBeenCalled();

    sessionAuthorization.resolve('denied');
    await flushPromises();

    expect(mockStart).not.toHaveBeenCalled();
  });

  it('starts, stops, and resumes collection as the analytics preference changes', async () => {
    const appsFlyer = await loadStartedAppsFlyer();

    expect(mockStart).toHaveBeenCalledTimes(1);

    setConfigState({
      config: { defaultMode: 'cloud', usageAnalyticsEnabled: false },
      isLoading: false,
    });

    expect(mockStop).toHaveBeenCalledWith({ shouldStop: true });

    setConfigState({
      config: { defaultMode: 'cloud', usageAnalyticsEnabled: true },
      isLoading: false,
    });
    await flushPromises();

    expect(mockStop).toHaveBeenLastCalledWith({ shouldStop: false });
    expect(mockStart).toHaveBeenCalledTimes(1);
  });

  it('waits to start until Usage Analytics is re-enabled after session-ready', async () => {
    const appsFlyer = await loadInitializedAppsFlyer();
    setConfigState({
      config: { defaultMode: 'cloud', usageAnalyticsEnabled: false },
      isLoading: false,
    });
    mockSessionReadyListener?.();

    expect(mockStart).not.toHaveBeenCalled();

    setConfigState({
      config: { defaultMode: 'cloud', usageAnalyticsEnabled: true },
      isLoading: false,
    });
    await flushPromises();

    expect(mockStart).toHaveBeenCalledTimes(1);
  });

  it('keeps events queued while the first session resumes and starts', async () => {
    const appsFlyer = await loadInitializedAppsFlyer();

    setConfigState({
      config: { defaultMode: 'cloud', usageAnalyticsEnabled: false },
      isLoading: false,
    });
    mockSessionReadyListener?.();

    const resume = deferred<void>();
    mockStop.mockReturnValueOnce(resume.promise);
    setConfigState({
      config: { defaultMode: 'cloud', usageAnalyticsEnabled: true },
      isLoading: false,
    });
    appsFlyer.logAppsFlyerEvent('af_trial_started');

    expect(mockLogEvent).not.toHaveBeenCalled();

    resume.resolve();
    await flushPromises();

    expect(mockStart).toHaveBeenCalledTimes(1);
    expect(mockLogEvent).toHaveBeenCalledWith({
      eventName: 'af_trial_started',
      eventValues: {},
    });
  });

  it('does not flush resumed events before the SDK reports session-ready', async () => {
    const appsFlyer = await loadInitializedAppsFlyer();

    setConfigState({
      config: { defaultMode: 'cloud', usageAnalyticsEnabled: false },
      isLoading: false,
    });
    setConfigState({
      config: { defaultMode: 'cloud', usageAnalyticsEnabled: true },
      isLoading: false,
    });
    appsFlyer.logAppsFlyerEvent('af_trial_started');
    await flushPromises();

    expect(mockStart).not.toHaveBeenCalled();
    expect(mockLogEvent).not.toHaveBeenCalled();

    mockSessionReadyListener?.();
    await flushPromises();

    expect(mockStart).toHaveBeenCalledTimes(1);
    expect(mockLogEvent).toHaveBeenCalledWith({
      eventName: 'af_trial_started',
      eventValues: {},
    });
  });

  it('waits for analytics collection to resume before sending an event', async () => {
    const appsFlyer = await loadStartedAppsFlyer();

    setConfigState({
      config: { defaultMode: 'cloud', usageAnalyticsEnabled: false },
      isLoading: false,
    });
    const resume = deferred<void>();
    mockStop.mockReturnValueOnce(resume.promise);
    setConfigState({
      config: { defaultMode: 'cloud', usageAnalyticsEnabled: true },
      isLoading: false,
    });
    appsFlyer.logAppsFlyerEvent('af_trial_started');

    expect(mockLogEvent).not.toHaveBeenCalled();

    resume.resolve();
    await flushPromises();

    expect(mockLogEvent).toHaveBeenCalledWith({
      eventName: 'af_trial_started',
      eventValues: {},
    });
  });

  it('drops a queued event when analytics are disabled before the SDK is ready', async () => {
    const initialization = deferred<void>();
    mockInit.mockReturnValueOnce(initialization.promise);
    const appsFlyer = loadAppsFlyer();

    appsFlyer.initAppsFlyer();
    setConfigState({
      config: { defaultMode: 'cloud', usageAnalyticsEnabled: true },
      isLoading: false,
    });
    appsFlyer.logAppsFlyerEvent('af_trial_started');
    setConfigState({
      config: { defaultMode: 'cloud', usageAnalyticsEnabled: false },
      isLoading: false,
    });

    initialization.resolve();
    await flushPromises();

    expect(mockLogEvent).not.toHaveBeenCalled();
  });

  it('suppresses events before hydration and after analytics are disabled', async () => {
    const appsFlyer = loadAppsFlyer();

    appsFlyer.initAppsFlyer();
    appsFlyer.logAppsFlyerEvent('af_trial_started', { source: 'paywall' });

    setConfigState({
      config: { defaultMode: 'cloud', usageAnalyticsEnabled: true },
      isLoading: false,
    });
    await flushPromises();
    mockSessionReadyListener?.();
    await flushPromises();
    appsFlyer.logAppsFlyerEvent('af_trial_started', { source: 'paywall' });
    await flushPromises();

    setConfigState({
      config: { defaultMode: 'cloud', usageAnalyticsEnabled: false },
      isLoading: false,
    });
    appsFlyer.logAppsFlyerEvent('af_trial_started', { source: 'paywall' });

    expect(mockLogEvent).toHaveBeenCalledTimes(1);
    expect(mockLogEvent).toHaveBeenCalledWith({
      eventName: 'af_trial_started',
      eventValues: { source: 'paywall' },
    });
  });

  it('does not initialize or start before the ATT decision resolves', async () => {
    const authorization = deferred<TrackingAuthorizationStatus>();
    mockGetTrackingAuthorizationStatus.mockReturnValue(authorization.promise);
    const appsFlyer = loadAppsFlyer();

    appsFlyer.initAppsFlyer();
    setConfigState({
      config: { defaultMode: 'cloud', usageAnalyticsEnabled: true },
      isLoading: false,
    });

    expect(mockInit).not.toHaveBeenCalled();
    expect(mockStart).not.toHaveBeenCalled();

    authorization.resolve('authorized');
    await flushPromises();

    expect(mockInit).toHaveBeenCalledTimes(1);
  });

  it('keeps the SDK off after ATT is denied', async () => {
    mockGetTrackingAuthorizationStatus.mockResolvedValue('denied');
    const appsFlyer = loadAppsFlyer();

    appsFlyer.initAppsFlyer();
    setConfigState({
      config: { defaultMode: 'cloud', usageAnalyticsEnabled: true },
      isLoading: false,
    });
    await flushPromises();
    appsFlyer.logAppsFlyerEvent('af_trial_started');

    expect(mockInit).not.toHaveBeenCalled();
    expect(mockEnableDebug).not.toHaveBeenCalled();
    expect(mockRegisterSessionReadyListener).not.toHaveBeenCalled();
    expect(mockStart).not.toHaveBeenCalled();
    expect(mockLogEvent).not.toHaveBeenCalled();
  });

  it('does not recheck or pause the SDK after ATT is known to be unsupported', async () => {
    mockGetTrackingAuthorizationStatus.mockResolvedValue('notSupported');
    const appsFlyer = await loadStartedAppsFlyer();
    mockStop.mockClear();

    await appsFlyer.refreshAppsFlyerTrackingAuthorization();

    expect(mockGetTrackingAuthorizationStatus).toHaveBeenCalledTimes(1);
    expect(mockStop).not.toHaveBeenCalled();
  });

  it('handles a synchronous session start failure at the SDK boundary', async () => {
    mockGetTrackingAuthorizationStatus.mockResolvedValue('notSupported');
    const appsFlyer = await loadInitializedAppsFlyer();
    mockStart.mockImplementationOnce(() => {
      throw new Error('native bridge unavailable');
    });

    mockSessionReadyListener?.();
    await flushPromises();

    expect(console.warn).toHaveBeenCalledWith(
      '[appsflyer] start failed',
      expect.objectContaining({ message: 'native bridge unavailable' }),
    );
  });

  it('queues an event while ATT is unresolved and sends it only after authorization', async () => {
    const authorization = deferred<TrackingAuthorizationStatus>();
    mockGetTrackingAuthorizationStatus.mockReturnValue(authorization.promise);
    const appsFlyer = loadAppsFlyer();

    appsFlyer.initAppsFlyer();
    setConfigState({
      config: { defaultMode: 'cloud', usageAnalyticsEnabled: true },
      isLoading: false,
    });
    appsFlyer.logAppsFlyerEvent('af_tutorial_completion', { af_success: true });

    expect(mockInit).not.toHaveBeenCalled();
    expect(mockLogEvent).not.toHaveBeenCalled();

    appsFlyer.setAppsFlyerTrackingAuthorizationStatus('authorized');
    mockGetTrackingAuthorizationStatus.mockResolvedValue('authorized');
    await flushPromises();

    expect(mockLogEvent).not.toHaveBeenCalled();

    mockSessionReadyListener?.();
    await flushPromises();

    expect(mockInit).toHaveBeenCalledTimes(1);
    expect(mockLogEvent).toHaveBeenCalledWith({
      eventName: 'af_tutorial_completion',
      eventValues: { af_success: true },
    });
  });

  it('does not let a stale startup check override the native prompt result', async () => {
    const startupAuthorization = deferred<TrackingAuthorizationStatus>();
    mockGetTrackingAuthorizationStatus.mockReturnValue(startupAuthorization.promise);
    const appsFlyer = loadAppsFlyer();

    appsFlyer.initAppsFlyer();
    setConfigState({
      config: { defaultMode: 'cloud', usageAnalyticsEnabled: true },
      isLoading: false,
    });
    appsFlyer.setAppsFlyerTrackingAuthorizationStatus('authorized');
    await flushPromises();
    mockStop.mockClear();

    startupAuthorization.resolve('denied');
    await flushPromises();

    expect(mockInit).toHaveBeenCalledTimes(1);
    expect(mockStop).not.toHaveBeenCalled();
  });

  it('discards pending events when ATT is denied', async () => {
    const authorization = deferred<TrackingAuthorizationStatus>();
    mockGetTrackingAuthorizationStatus.mockReturnValue(authorization.promise);
    const appsFlyer = loadAppsFlyer();

    appsFlyer.initAppsFlyer();
    setConfigState({
      config: { defaultMode: 'cloud', usageAnalyticsEnabled: true },
      isLoading: false,
    });
    appsFlyer.logAppsFlyerEvent('af_tutorial_completion');
    appsFlyer.setAppsFlyerTrackingAuthorizationStatus('denied');
    appsFlyer.setAppsFlyerTrackingAuthorizationStatus('authorized');
    await flushPromises();

    expect(mockInit).toHaveBeenCalledTimes(1);
    expect(mockLogEvent).not.toHaveBeenCalled();
  });

  it('stops the initialized SDK when ATT authorization is revoked', async () => {
    const appsFlyer = loadAppsFlyer();
    appsFlyer.initAppsFlyer();
    setConfigState({
      config: { defaultMode: 'cloud', usageAnalyticsEnabled: true },
      isLoading: false,
    });
    await flushPromises();

    appsFlyer.setAppsFlyerTrackingAuthorizationStatus('denied');

    expect(mockStop).toHaveBeenCalledWith({ shouldStop: true });
  });

  it('does not let a synchronous SDK stop failure escape an ATT update', async () => {
    const appsFlyer = await loadInitializedAppsFlyer();
    mockStop.mockImplementationOnce(() => {
      throw new Error('native bridge unavailable');
    });

    expect(() => appsFlyer.setAppsFlyerTrackingAuthorizationStatus('denied')).not.toThrow();
    await flushPromises();

    expect(console.warn).toHaveBeenCalledWith(
      '[appsflyer] stop failed',
      expect.objectContaining({ message: 'native bridge unavailable' }),
    );
  });

  it('pauses collection while refreshing ATT for an initialized SDK', async () => {
    const appsFlyer = await loadStartedAppsFlyer();
    mockStop.mockClear();
    mockLogEvent.mockClear();

    const authorization = deferred<TrackingAuthorizationStatus>();
    mockGetTrackingAuthorizationStatus.mockReturnValueOnce(authorization.promise);
    const refresh = appsFlyer.refreshAppsFlyerTrackingAuthorization();
    await flushPromises();

    expect(mockStop).toHaveBeenCalledWith({ shouldStop: true });

    appsFlyer.logAppsFlyerEvent('af_trial_started');
    await flushPromises();
    expect(mockLogEvent).not.toHaveBeenCalled();

    authorization.resolve('authorized');
    await refresh;
    await flushPromises();

    expect(mockStop).toHaveBeenLastCalledWith({ shouldStop: false });
  });

  it('finishes pausing the SDK before resuming after an authorized refresh', async () => {
    const appsFlyer = await loadStartedAppsFlyer();
    mockStop.mockClear();

    const pause = deferred<void>();
    mockStop.mockReturnValueOnce(pause.promise);
    mockGetTrackingAuthorizationStatus.mockResolvedValueOnce('authorized');

    await appsFlyer.refreshAppsFlyerTrackingAuthorization();
    await flushPromises();

    expect(mockStop).toHaveBeenCalledTimes(1);
    expect(mockStop).toHaveBeenCalledWith({ shouldStop: true });

    pause.resolve();
    await flushPromises();

    expect(mockStop).toHaveBeenNthCalledWith(2, { shouldStop: false });
  });

  it('keeps collection paused and reports an ATT refresh error to its caller', async () => {
    const appsFlyer = await loadStartedAppsFlyer();
    mockStop.mockClear();

    const error = new Error('ATT status unavailable');
    mockGetTrackingAuthorizationStatus.mockRejectedValueOnce(error);

    await expect(appsFlyer.refreshAppsFlyerTrackingAuthorization()).rejects.toBe(error);

    expect(mockStop).toHaveBeenCalledTimes(1);
    expect(mockStop).toHaveBeenCalledWith({ shouldStop: true });
  });
});

describe('AppsFlyer MVP events', () => {
  it('logs tutorial completion with only setup outcome fields', async () => {
    const appsFlyer = await loadStartedAppsFlyer();

    appsFlyer.logTutorialCompletion({
      keyboardInstalled: true,
      microphonePermissionGranted: false,
    });
    await flushPromises();

    expect(mockLogEvent).toHaveBeenCalledWith({
      eventName: 'af_tutorial_completion',
      eventValues: {
        af_success: true,
        keyboard_installed: true,
        microphone_permission_granted: false,
      },
    });
  });

  it('logs transcription completion with its source and provider', async () => {
    const appsFlyer = await loadStartedAppsFlyer();

    appsFlyer.logTranscriptionCompleted({ source: 'keyboard', provider: 'cloud' });
    await flushPromises();

    expect(mockLogEvent).toHaveBeenCalledWith({
      eventName: 'transcription_completed',
      eventValues: { source: 'keyboard', provider: 'cloud' },
    });
  });

  it('logs a presented paywall with its placement', async () => {
    const appsFlyer = await loadStartedAppsFlyer();

    appsFlyer.logPaywallViewed('account_billing_open');
    await flushPromises();

    expect(mockLogEvent).toHaveBeenCalledWith({
      eventName: 'paywall_viewed',
      eventValues: { placement: 'account_billing_open' },
    });
  });

  it('logs a new subscription with its product and placement', async () => {
    const appsFlyer = await loadStartedAppsFlyer();

    appsFlyer.logSubscription('pro.monthly', 'account_billing_open');
    await flushPromises();

    expect(mockLogEvent).toHaveBeenCalledWith({
      eventName: 'af_subscribe',
      eventValues: {
        af_subscription_id: 'pro.monthly',
        placement: 'account_billing_open',
      },
    });
  });

  it('suppresses every MVP event while analytics consent is unavailable or disabled', () => {
    const appsFlyer = loadAppsFlyer();
    appsFlyer.initAppsFlyer();

    appsFlyer.logTutorialCompletion({
      keyboardInstalled: true,
      microphonePermissionGranted: true,
    });
    appsFlyer.logTranscriptionCompleted({ source: 'recording', provider: 'local' });
    appsFlyer.logPaywallViewed('meeting_record_start');
    appsFlyer.logSubscription('pro.yearly', 'account_billing_open');

    setConfigState({
      config: { defaultMode: 'cloud', usageAnalyticsEnabled: false },
      isLoading: false,
    });
    appsFlyer.logTutorialCompletion({
      keyboardInstalled: false,
      microphonePermissionGranted: false,
    });
    appsFlyer.logTranscriptionCompleted({ source: 'file', provider: 'cloud' });
    appsFlyer.logPaywallViewed('audio_upload_start');
    appsFlyer.logSubscription('pro.monthly', 'account_billing_open');

    expect(mockLogEvent).not.toHaveBeenCalled();
  });

  it('does not let a synchronous SDK failure interrupt the completed app flow', async () => {
    const appsFlyer = await loadStartedAppsFlyer();
    mockLogEvent.mockImplementationOnce(() => {
      throw new Error('native bridge unavailable');
    });

    expect(() =>
      appsFlyer.logTranscriptionCompleted({ source: 'recording', provider: 'local' }),
    ).not.toThrow();
    await flushPromises();
    expect(console.warn).toHaveBeenCalledWith(
      '[appsflyer] failed to log transcription_completed',
      expect.objectContaining({ message: 'native bridge unavailable' }),
    );
  });
});

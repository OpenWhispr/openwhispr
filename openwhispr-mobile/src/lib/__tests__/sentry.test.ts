import type { ReactNativeOptions } from '@sentry/react-native';
import type { UserConfig } from '@/types';

type SentryModule = typeof import('../sentry');
type ReplayOptions = NonNullable<
  Parameters<(typeof import('@sentry/react-native'))['mobileReplayIntegration']>[0]
>;
type ErrorEvent = Parameters<NonNullable<ReactNativeOptions['beforeSend']>>[0];
type Log = Parameters<NonNullable<ReactNativeOptions['beforeSendLog']>>[0];

interface MockConfigState {
  config: UserConfig | null;
  isLoading: boolean;
}

let mockConfigState: MockConfigState = { config: null, isLoading: false };

const mockReplayIntegration = { name: 'MobileReplay' };
const mockInit = jest.fn<void, [ReactNativeOptions]>();
const mockClose = jest.fn(() => Promise.resolve(true));
const mockMobileReplayIntegration = jest.fn<typeof mockReplayIntegration, [ReplayOptions?]>(
  () => mockReplayIntegration,
);
let mockConfigListener: (() => void) | undefined;
const mockSubscribe = jest.fn((listener: () => void) => {
  mockConfigListener = listener;
  return () => {};
});
const mockGetConfigState = jest.fn((): MockConfigState => mockConfigState);

jest.mock('@sentry/react-native', () => ({
  init: mockInit,
  close: mockClose,
  mobileReplayIntegration: mockMobileReplayIntegration,
}));

jest.mock('@/store/useConfigStore', () => ({
  useConfigStore: { getState: mockGetConfigState, subscribe: mockSubscribe },
}));

const originalDsn = process.env.EXPO_PUBLIC_SENTRY_DSN;

function setAnalyticsEnabled(enabled: boolean | undefined): void {
  mockConfigState = {
    config: { defaultMode: 'cloud', usageAnalyticsEnabled: enabled },
    isLoading: false,
  };
}

function loadSentry(): SentryModule {
  jest.resetModules();
  return require('../sentry') as SentryModule;
}

interface Gates {
  options: ReactNativeOptions;
  replay: ReplayOptions;
}

function initGates(): Gates {
  const initialState = mockConfigState;
  setAnalyticsEnabled(true);
  loadSentry().initSentry();
  mockConfigState = initialState;
  expect(mockInit).toHaveBeenCalledTimes(1);
  expect(mockMobileReplayIntegration).toHaveBeenCalledTimes(1);
  const [replay] = mockMobileReplayIntegration.mock.calls[0];
  if (!replay) throw new Error('mobileReplayIntegration was called without options');
  return { options: mockInit.mock.calls[0][0], replay };
}

const event: ErrorEvent = {
  type: undefined,
  event_id: 'evt',
  exception: { values: [{ type: 'Error' }] },
};
const hint = {};
const breadcrumb = { category: 'test', message: 'crumb' };
const log: Log = { level: 'info', message: 'structured log' };

function gateResults({ options, replay }: Gates) {
  return {
    event: options.beforeSend?.(event, hint),
    breadcrumb: options.beforeBreadcrumb?.(breadcrumb, hint),
    log: options.beforeSendLog?.(log),
    replay: replay.beforeErrorSampling?.(event, hint),
  };
}

const passThrough = { event, breadcrumb, log, replay: true };
const dropped = { event: null, breadcrumb: null, log: null, replay: false };

beforeEach(() => {
  process.env.EXPO_PUBLIC_SENTRY_DSN = 'https://public@sentry.example/1';
  mockConfigState = { config: null, isLoading: false };
  jest.clearAllMocks();
});

afterAll(() => {
  if (originalDsn === undefined) {
    delete process.env.EXPO_PUBLIC_SENTRY_DSN;
  } else {
    process.env.EXPO_PUBLIC_SENTRY_DSN = originalDsn;
  }
});

describe('initSentry', () => {
  it('does not initialize without a DSN and never initializes twice', () => {
    delete process.env.EXPO_PUBLIC_SENTRY_DSN;
    const sentry = loadSentry();
    sentry.initSentry();
    sentry.initSentry();
    expect(mockInit).not.toHaveBeenCalled();

    process.env.EXPO_PUBLIC_SENTRY_DSN = 'https://public@sentry.example/1';
    setAnalyticsEnabled(true);
    const initialized = loadSentry();
    initialized.initSentry();
    initialized.initSentry();
    expect(mockInit).toHaveBeenCalledTimes(1);
  });

  it('keeps PII off and only buffers replays for errors', () => {
    expect(initGates().options).toMatchObject({
      dsn: 'https://public@sentry.example/1',
      sendDefaultPii: false,
      enableLogs: true,
      replaysSessionSampleRate: 0,
      replaysOnErrorSampleRate: 1,
      integrations: [mockReplayIntegration],
    });
  });

  it('pins replay masking explicitly instead of relying on SDK defaults', () => {
    expect(initGates().replay).toMatchObject({
      maskAllText: true,
      maskAllImages: true,
      maskAllVectors: true,
    });
  });
});

describe('Usage Analytics gate', () => {
  it('passes events, breadcrumbs, logs and replays through when enabled', () => {
    setAnalyticsEnabled(true);
    const gates = initGates();
    expect(gateResults(gates)).toEqual(passThrough);
  });

  it('drops events, breadcrumbs, logs and replays when disabled', () => {
    setAnalyticsEnabled(false);
    const gates = initGates();
    expect(gateResults(gates)).toEqual(dropped);
  });

  it('drops all channels until config finishes hydrating', () => {
    const gates = initGates();
    expect(gateResults(gates)).toEqual(dropped);

    setAnalyticsEnabled(undefined);
    expect(gateResults(gates)).toEqual(passThrough);
  });

  it('keeps every channel open while a preference save is in flight', () => {
    setAnalyticsEnabled(true);
    mockConfigState.isLoading = true;
    expect(gateResults(initGates())).toEqual(passThrough);
  });

  it('stops and restarts every channel when the toggle flips at runtime', () => {
    setAnalyticsEnabled(true);
    const gates = initGates();
    expect(gateResults(gates)).toEqual(passThrough);

    setAnalyticsEnabled(false);
    expect(gateResults(gates)).toEqual(dropped);

    setAnalyticsEnabled(true);
    expect(gateResults(gates)).toEqual(passThrough);
    expect(mockInit).toHaveBeenCalledTimes(1);
  });
});

it('waits for loaded consent before starting native capture and replay buffering', () => {
  const sentry = loadSentry();
  sentry.initSentry();
  expect(mockInit).not.toHaveBeenCalled();
  setAnalyticsEnabled(false);
  mockConfigListener?.();
  expect(mockInit).not.toHaveBeenCalled();
  setAnalyticsEnabled(true);
  mockConfigListener?.();
  expect(mockInit).toHaveBeenCalledTimes(1);
});

it('keeps native crash reporting on for consenting users', () => {
  const { options } = initGates();
  expect(options.logsOrigin).toBe('js');
  expect(options.enableNativeCrashHandling).toBeUndefined();
  expect(options.enableAppHangTracking).toBeUndefined();
  expect(options.enableWatchdogTerminationTracking).toBeUndefined();
});

it('closes the SDK when consent is withdrawn and re-initializes when it is granted again', async () => {
  setAnalyticsEnabled(true);
  loadSentry().initSentry();
  expect(mockInit).toHaveBeenCalledTimes(1);

  setAnalyticsEnabled(false);
  mockConfigListener?.();
  expect(mockClose).toHaveBeenCalledTimes(1);

  setAnalyticsEnabled(true);
  mockConfigListener?.();
  await mockClose.mock.results[0].value;
  await Promise.resolve();
  expect(mockInit).toHaveBeenCalledTimes(2);
  expect(mockClose).toHaveBeenCalledTimes(1);
});

it.each([true, false])('uses the latest consent (%s) after a pending shutdown', async (enabled) => {
  let finishClose!: (result: boolean) => void;
  const pendingClose = new Promise<boolean>((resolve) => {
    finishClose = resolve;
  });
  mockClose.mockReturnValueOnce(pendingClose);
  setAnalyticsEnabled(true);
  const sentry = loadSentry();
  sentry.initSentry();

  setAnalyticsEnabled(false);
  mockConfigListener?.();
  setAnalyticsEnabled(true);
  mockConfigListener?.();
  setAnalyticsEnabled(enabled);
  mockConfigListener?.();
  sentry.initSentry();
  expect(mockInit).toHaveBeenCalledTimes(1);

  finishClose(true);
  await pendingClose;
  await Promise.resolve();
  expect(mockInit).toHaveBeenCalledTimes(enabled ? 2 : 1);
  expect(mockClose).toHaveBeenCalledTimes(1);
});

import {
  dismissFullAccessBanner,
  evaluate,
  reportIfDue,
  shouldShowFullAccessBanner,
} from '@/lib/keyboardFullAccessProbe';

const store: Record<string, string> = {};
let mockActiveInputModes: string[] = [];

jest.mock('../../../modules/app-group-storage/src', () => ({
  AppGroupStorage: {
    getItem: (key: string) => store[key] ?? null,
    setItem: (key: string, value: string) => {
      store[key] = value;
      return true;
    },
    getActiveInputModes: () => mockActiveInputModes,
  },
  APP_GROUP_KEYS: {
    KEYBOARD_SHOWN_AT_MS: 'keyboard_shown_at_ms',
    KEYBOARD_SHOWN_VERSION: 'keyboard_shown_version',
    KEYBOARD_FULL_ACCESS_PROBE: 'keyboard_full_access_probe',
  },
}));

jest.mock('react-native', () => ({
  AppState: { addEventListener: () => ({ remove: () => {} }) },
  Platform: { OS: 'ios', Version: '26.0' },
}));

const mockCaptureMessage = jest.fn();
jest.mock('@/lib/sentry', () => ({
  Sentry: { captureMessage: (...args: unknown[]) => mockCaptureMessage(...args) },
}));

// Mirrors the native pair the probe keys on: a TestFlight rebuild bumps only
// nativeBuildVersion, and that alone has to roll the probe.
jest.mock('expo-application', () => ({
  nativeApplicationVersion: '1.4.0',
  nativeBuildVersion: '42',
}));

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = 1_800_000_000_000;

beforeEach(() => {
  for (const key of Object.keys(store)) delete store[key];
  mockActiveInputModes = ['mul'];
  mockCaptureMessage.mockClear();
});

describe('evaluate', () => {
  it('treats a heartbeat written since this version launched as healthy', () => {
    store.keyboard_full_access_probe = JSON.stringify({
      version: '1.4.0+42',
      firstSeenAtMs: NOW - DAY_MS,
      previousVersion: '1.3.0',
      reportedVersion: null,
    });
    store.keyboard_shown_at_ms = String(NOW - 60_000);

    const reading = evaluate(NOW);

    expect(reading.heartbeatSeenThisVersion).toBe(true);
    expect(reading.heartbeatAgeMs).toBe(60_000);
    expect(reading.previousAppVersion).toBe('1.3.0');
  });

  it('treats a heartbeat that predates the current version as not seen', () => {
    store.keyboard_full_access_probe = JSON.stringify({
      version: '1.4.0+42',
      firstSeenAtMs: NOW - DAY_MS,
      previousVersion: '1.3.0',
      reportedVersion: null,
    });
    // Keyboard last worked before the update landed — the exact signature of a
    // permission reset.
    store.keyboard_shown_at_ms = String(NOW - 3 * DAY_MS);

    expect(evaluate(NOW).heartbeatSeenThisVersion).toBe(false);
  });

  it('records the previous version when the app updates', () => {
    store.keyboard_full_access_probe = JSON.stringify({
      version: '1.3.0',
      firstSeenAtMs: NOW - 10 * DAY_MS,
      previousVersion: null,
      reportedVersion: '1.3.0',
    });

    const reading = evaluate(NOW);

    expect(reading.appVersion).toBe('1.4.0+42');
    expect(reading.previousAppVersion).toBe('1.3.0');
    expect(reading.versionAgeMs).toBe(0);
  });
});

describe('reportIfDue', () => {
  it('stays silent while a fresh version could simply be unused', () => {
    expect(reportIfDue(NOW)).toBeNull();
    expect(mockCaptureMessage).not.toHaveBeenCalled();
  });

  it('reports a muted keyboard once the confidence window has passed', () => {
    store.keyboard_full_access_probe = JSON.stringify({
      version: '1.4.0+42',
      firstSeenAtMs: NOW - DAY_MS,
      previousVersion: '1.3.0',
      reportedVersion: null,
    });
    store.keyboard_shown_at_ms = String(NOW - 5 * DAY_MS);

    const reading = reportIfDue(NOW);

    expect(reading?.heartbeatSeenThisVersion).toBe(false);
    expect(mockCaptureMessage).toHaveBeenCalledWith(
      'keyboard.full_access_probe',
      expect.objectContaining({
        tags: expect.objectContaining({
          keyboardInstalled: 'true',
          heartbeatSeenThisVersion: 'false',
          heartbeatSeenThisBuild: 'false',
          appVersion: '1.4.0+42',
          iosVersion: '26.0',
        }),
        extra: expect.objectContaining({ heartbeatVersion: null }),
      }),
    );
  });

  it('reports a healthy install immediately, without waiting', () => {
    store.keyboard_shown_at_ms = String(NOW);

    expect(reportIfDue(NOW)?.heartbeatSeenThisVersion).toBe(true);
    expect(mockCaptureMessage).toHaveBeenCalledTimes(1);
  });

  it('reports a keyboard that was never added immediately', () => {
    mockActiveInputModes = ['en-US'];

    expect(reportIfDue(NOW)?.keyboardInstalled).toBe(false);
    expect(mockCaptureMessage).toHaveBeenCalledTimes(1);
  });

  it('reports at most once per app version', () => {
    store.keyboard_shown_at_ms = String(NOW);

    reportIfDue(NOW);
    reportIfDue(NOW + 60_000);
    reportIfDue(NOW + DAY_MS);

    expect(mockCaptureMessage).toHaveBeenCalledTimes(1);
  });

  // The blocker this keying fixes: eas.json autoIncrement ships TestFlight builds
  // that move only the build number, and each is a fresh native install where iOS
  // can have reset Full Access.
  it('reports again when only the native build number changes', () => {
    store.keyboard_shown_at_ms = String(NOW);
    // The previous TestFlight build of the same marketing version already reported.
    store.keyboard_full_access_probe = JSON.stringify({
      version: '1.4.0+41',
      firstSeenAtMs: NOW - DAY_MS,
      previousVersion: '1.3.0',
      reportedVersion: '1.4.0+41',
    });

    const reading = reportIfDue(NOW);

    // Pins the build number into the key: drop it and appVersion collapses to
    // '1.4.0', which cannot distinguish one TestFlight build from the next.
    expect(reading?.appVersion).toBe('1.4.0+42');
    expect(reading?.previousAppVersion).toBe('1.4.0+41');
    expect(mockCaptureMessage).toHaveBeenCalledTimes(1);
  });

  it('reports again after the app updates', () => {
    store.keyboard_shown_at_ms = String(NOW);
    reportIfDue(NOW);
    mockCaptureMessage.mockClear();

    store.keyboard_full_access_probe = JSON.stringify({
      ...JSON.parse(store.keyboard_full_access_probe),
      version: '1.3.9',
    });

    expect(reportIfDue(NOW)).not.toBeNull();
    expect(mockCaptureMessage).toHaveBeenCalledTimes(1);
  });

  it('survives a corrupt stored state instead of throwing', () => {
    store.keyboard_full_access_probe = 'not json';
    store.keyboard_shown_at_ms = String(NOW);

    expect(() => reportIfDue(NOW)).not.toThrow();
    expect(mockCaptureMessage).toHaveBeenCalledTimes(1);
  });
});

// The spec's section 5 table, one test per row. The mocked build identity is
// '1.4.0+42'; '1.4.0+41' plays the previous build.
describe('shouldShowFullAccessBanner — the section 5 scenarios', () => {
  it('shows for a revoked keyboard whose last heartbeat predates the update', () => {
    store.keyboard_full_access_probe = JSON.stringify({
      version: '1.4.0+42',
      firstSeenAtMs: NOW - 60_000,
      previousVersion: '1.4.0+41',
      reportedVersion: null,
    });
    // Last used 5 minutes before the update; the stamp still carries the
    // previous build's identity because the post-update write cannot land.
    store.keyboard_shown_at_ms = String(NOW - 5 * 60_000);
    store.keyboard_shown_version = '1.4.0+41';

    const reading = evaluate(NOW);

    expect(reading.heartbeatSeenThisBuild).toBe(false);
    expect(shouldShowFullAccessBanner(reading)).toBe(true);
  });

  it('hides for a healthy keyboard that typed after the update, before the app opened', () => {
    // First app launch on the new build: the probe state rolls at NOW, so the
    // heartbeat written an hour ago is older than firstSeenAtMs. The old
    // timestamp rule read that as unhealthy; the version stamp knows better.
    store.keyboard_shown_at_ms = String(NOW - 60 * 60_000);
    store.keyboard_shown_version = '1.4.0+42';

    const reading = evaluate(NOW);

    expect(reading.heartbeatSeenThisVersion).toBe(false); // the old rule's wrong answer
    expect(reading.heartbeatSeenThisBuild).toBe(true);
    expect(shouldShowFullAccessBanner(reading)).toBe(false);
  });

  it('shows for a healthy keyboard not yet used on this build, then clears on first use', () => {
    store.keyboard_shown_at_ms = String(NOW - 3 * DAY_MS);
    store.keyboard_shown_version = '1.4.0+41';

    // The unavoidable residual false positive…
    expect(shouldShowFullAccessBanner(evaluate(NOW))).toBe(true);

    // …which the keyboard's first appearance on this build clears.
    store.keyboard_shown_at_ms = String(NOW + 60_000);
    store.keyboard_shown_version = '1.4.0+42';

    expect(shouldShowFullAccessBanner(evaluate(NOW + 120_000))).toBe(false);
  });
});

describe('shouldShowFullAccessBanner — gating', () => {
  it('treats a heartbeat with no version stamp as not from this build (migration)', () => {
    // Pre-v2 keyboards never wrote keyboard_shown_version. Worst case the
    // banner shows once and clears on the first keyboard use.
    store.keyboard_shown_at_ms = String(NOW - 60_000);

    const reading = evaluate(NOW);

    expect(reading.heartbeatVersion).toBeNull();
    expect(reading.heartbeatSeenThisBuild).toBe(false);
    expect(shouldShowFullAccessBanner(reading)).toBe(true);
  });

  it('never shows for a keyboard that has never written a heartbeat', () => {
    // "Added the keyboard once, never used it" is not broken — and a user who
    // never granted Full Access is covered by onboarding plus the panel.
    const reading = evaluate(NOW);

    expect(reading.heartbeatAgeMs).toBeNull();
    expect(shouldShowFullAccessBanner(reading)).toBe(false);
  });

  it('never shows when the keyboard is not installed', () => {
    mockActiveInputModes = ['en-US'];
    store.keyboard_shown_at_ms = String(NOW - DAY_MS);

    expect(shouldShowFullAccessBanner(evaluate(NOW))).toBe(false);
  });
});

describe('dismissFullAccessBanner', () => {
  it('hides the banner for the current version', () => {
    store.keyboard_shown_at_ms = String(NOW - DAY_MS);
    expect(shouldShowFullAccessBanner(evaluate(NOW))).toBe(true);

    dismissFullAccessBanner(NOW);

    const reading = evaluate(NOW);
    expect(reading.bannerDismissedThisVersion).toBe(true);
    expect(shouldShowFullAccessBanner(reading)).toBe(false);
  });

  it('lapses when the app updates', () => {
    store.keyboard_shown_at_ms = String(NOW - DAY_MS);
    dismissFullAccessBanner(NOW);
    // Simulate the next update: the stored state belongs to an older build,
    // so currentState() rolls it and the dismissal does not carry over.
    store.keyboard_full_access_probe = JSON.stringify({
      ...JSON.parse(store.keyboard_full_access_probe),
      version: '1.4.0+41',
      bannerDismissedVersion: '1.4.0+41',
    });

    expect(shouldShowFullAccessBanner(evaluate(NOW + DAY_MS))).toBe(true);
  });
});

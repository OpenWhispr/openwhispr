import * as Application from 'expo-application';
import { AppState, Platform } from 'react-native';
import { isKeyboardInstalled } from '@/lib/keyboardInstallation';
import { Sentry } from '@/lib/sentry';
import { AppGroupStorage, APP_GROUP_KEYS } from '../../modules/app-group-storage/src';

// Measures how many installs have a keyboard that iOS has silently muted.
//
// The keyboard writes KEYBOARD_SHOWN_AT_MS every time it appears, and that write
// only lands when Full Access is granted. So an installed keyboard that has not
// written since this app version arrived has almost certainly lost the
// permission. The extension cannot report the loss itself: reporting would need
// the very shared container the loss takes away.

// A heartbeat can also be missing simply because nobody has opened the keyboard
// yet. Absence only becomes evidence once the version has been installed long
// enough for ordinary use to have happened.
const CONFIDENCE_WINDOW_MS = 24 * 60 * 60 * 1000;

const PROBE_EVENT = 'keyboard.full_access_probe';

interface ProbeState {
  readonly version: string;
  readonly firstSeenAtMs: number;
  readonly previousVersion: string | null;
  readonly reportedVersion: string | null;
  readonly bannerDismissedVersion: string | null;
}

export interface ProbeReading {
  readonly keyboardInstalled: boolean;
  readonly heartbeatSeenThisVersion: boolean;
  readonly heartbeatAgeMs: number | null;
  readonly versionAgeMs: number;
  readonly appVersion: string;
  readonly previousAppVersion: string | null;
  readonly heartbeatVersion: string | null;
  readonly heartbeatSeenThisBuild: boolean;
  readonly bannerDismissedThisVersion: boolean;
}

// Keyed on the NATIVE build identity rather than app.json's `version`, because
// only the native install boundary is where iOS can reset Full Access.
// eas.json sets autoIncrement on the production profile, so every TestFlight
// build is a fresh install while `version` stays put — keying on it would report
// once per release and then stay silent through the whole cycle. It errs the
// other way too: an expo-updates OTA can bump `version` with no native install,
// rolling the probe for a reset that cannot have happened.
function appVersion(): string {
  const version = Application.nativeApplicationVersion ?? 'unknown';
  const build = Application.nativeBuildVersion ?? 'unknown';
  return `${version}+${build}`;
}

function readState(): ProbeState | null {
  const raw = AppGroupStorage.getItem(APP_GROUP_KEYS.KEYBOARD_FULL_ACCESS_PROBE);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<ProbeState>;
    if (typeof parsed.version !== 'string' || typeof parsed.firstSeenAtMs !== 'number') return null;
    return {
      version: parsed.version,
      firstSeenAtMs: parsed.firstSeenAtMs,
      previousVersion: typeof parsed.previousVersion === 'string' ? parsed.previousVersion : null,
      reportedVersion: typeof parsed.reportedVersion === 'string' ? parsed.reportedVersion : null,
      bannerDismissedVersion:
        typeof parsed.bannerDismissedVersion === 'string' ? parsed.bannerDismissedVersion : null,
    };
  } catch {
    return null;
  }
}

function writeState(state: ProbeState): void {
  AppGroupStorage.setItem(APP_GROUP_KEYS.KEYBOARD_FULL_ACCESS_PROBE, JSON.stringify(state));
}

function readHeartbeatAtMs(): number | null {
  const raw = AppGroupStorage.getItem(APP_GROUP_KEYS.KEYBOARD_SHOWN_AT_MS);
  if (!raw) return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

function readHeartbeatVersion(): string | null {
  return AppGroupStorage.getItem(APP_GROUP_KEYS.KEYBOARD_SHOWN_VERSION) || null;
}

// Rolls the stored version marker when the app updates, so `firstSeenAtMs`
// always describes the version running now.
function currentState(now: number): ProbeState {
  const version = appVersion();
  const stored = readState();
  if (stored?.version === version) return stored;

  const rolled: ProbeState = {
    version,
    firstSeenAtMs: now,
    previousVersion: stored?.version ?? null,
    reportedVersion: null,
    bannerDismissedVersion: null,
  };
  writeState(rolled);
  return rolled;
}

export function evaluate(now: number): ProbeReading {
  const state = currentState(now);
  const heartbeatAtMs = readHeartbeatAtMs();
  const heartbeatVersion = readHeartbeatVersion();

  return {
    keyboardInstalled: isKeyboardInstalled(),
    heartbeatSeenThisVersion: heartbeatAtMs !== null && heartbeatAtMs >= state.firstSeenAtMs,
    heartbeatAgeMs: heartbeatAtMs === null ? null : Math.max(0, now - heartbeatAtMs),
    versionAgeMs: Math.max(0, now - state.firstSeenAtMs),
    appVersion: state.version,
    previousAppVersion: state.previousVersion,
    heartbeatVersion,
    // Version identity, not timestamps: the app cannot learn when iOS installed
    // an update, so "was the stamp written by this build?" is the only question
    // a comparison can answer. A missing stamp reads as "not this build" — the
    // safe answer for pre-v2 keyboards (migration).
    heartbeatSeenThisBuild: heartbeatVersion !== null && heartbeatVersion === state.version,
    bannerDismissedThisVersion: state.bannerDismissedVersion === state.version,
  };
}

// The Home banner's visibility rule (spec §2). heartbeatAgeMs !== null drops
// the "added the keyboard once, never used it" cohort, who would otherwise
// see the banner forever; the panel is the in-context signal for them.
export function shouldShowFullAccessBanner(reading: ProbeReading): boolean {
  return (
    reading.keyboardInstalled &&
    !reading.heartbeatSeenThisBuild &&
    reading.heartbeatAgeMs !== null &&
    !reading.bannerDismissedThisVersion
  );
}

export function dismissFullAccessBanner(now: number): void {
  const state = currentState(now);
  writeState({ ...state, bannerDismissedVersion: state.version });
}

// One event per app version: a healthy install reports as soon as the keyboard
// proves it can write, an unhealthy one waits out the confidence window so the
// silence means something. Both arrive exactly once, which keeps this cheap
// enough to leave on permanently.
function isReportable(reading: ProbeReading): boolean {
  if (!reading.keyboardInstalled) return true;
  if (reading.heartbeatSeenThisVersion) return true;
  return reading.versionAgeMs >= CONFIDENCE_WINDOW_MS;
}

export function reportIfDue(now: number): ProbeReading | null {
  const state = currentState(now);
  if (state.reportedVersion === state.version) return null;

  const reading = evaluate(now);
  if (!isReportable(reading)) return null;

  Sentry.captureMessage(PROBE_EVENT, {
    level: 'info',
    tags: {
      keyboardInstalled: String(reading.keyboardInstalled),
      heartbeatSeenThisVersion: String(reading.heartbeatSeenThisVersion),
      heartbeatSeenThisBuild: String(reading.heartbeatSeenThisBuild),
      appVersion: reading.appVersion,
      iosVersion: String(Platform.Version),
    },
    extra: {
      heartbeatAgeMs: reading.heartbeatAgeMs,
      versionAgeMs: reading.versionAgeMs,
      previousAppVersion: reading.previousAppVersion,
      heartbeatVersion: reading.heartbeatVersion,
    },
  });

  writeState({ ...state, reportedVersion: state.version });
  return reading;
}

// This runs inside a zustand subscriber during startup, so an escaping throw would
// surface out of loadConfig *and* skip the effect's cleanup registration, leaking
// the tone and agent listeners behind an already-latched `started`. A probe is
// never worth that.
function reportSafely(): void {
  try {
    reportIfDue(Date.now());
  } catch (error) {
    console.warn('[keyboard-full-access-probe] report failed', error);
  }
}

export function startKeyboardFullAccessProbe(): () => void {
  if (Platform.OS !== 'ios') return () => {};

  reportSafely();

  const subscription = AppState.addEventListener('change', (state) => {
    if (state === 'active') reportSafely();
  });

  return () => subscription.remove();
}

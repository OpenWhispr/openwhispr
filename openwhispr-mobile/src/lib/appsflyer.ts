import { Platform } from 'react-native';
import { useConfigStore } from '@/store/useConfigStore';
import {
  getTrackingAuthorizationStatus,
  type TrackingAuthorizationStatus,
} from '@/lib/trackingTransparency';
import type { SuperwallPlacement } from '@/lib/superwall';
import type { TranscriptionProvider } from '@/types';

type AppsFlyerSdk = (typeof import('react-native-appsflyer'))['default'];

export type TranscriptionSource = 'keyboard' | 'recording' | 'file' | 'meeting';

type TutorialCompletionInput = {
  keyboardInstalled: boolean;
  microphonePermissionGranted: boolean;
};

type TranscriptionCompletionInput = {
  source: TranscriptionSource;
  provider: TranscriptionProvider;
};

interface PendingEvent {
  eventName: string;
  eventValues: Record<string, unknown>;
}

const DEV_KEY = process.env.EXPO_PUBLIC_APPSFLYER_DEV_KEY?.trim();

// Numeric App Store ID (see ascAppId in eas.json). Required by the iOS SDK;
// ignored on Android.
const IOS_APP_ID = '6763804420';
const MAX_PENDING_EVENTS = 20;
const REVENUE_ID_LOOKUP_TIMEOUT_MS = 2_000;

let didSetUp = false;
let didInit = false;
let stopped = false;
let sessionReady = false;
let didStartCurrentSession = false;
let sdkReady: Promise<boolean> | null = null;
let sdkStateChange: Promise<void> | null = null;
let trackingAuthorizationStatus: TrackingAuthorizationStatus | null = null;
let trackingRefreshRevision = 0;
let pendingEvents: PendingEvent[] = [];
const attributionListeners = new Set<() => void>();
let lastPublishedConsent: AppsFlyerAttributionConsent | undefined;
let revenueId: string | null = null;

// 'revoked' is an explicit opt-out on this device (Usage Analytics off, ATT
// denied). 'undecided' is a device that has not answered the ATT prompt, or a
// build without AppsFlyer: it can neither link nor opt out. 'pending' is an
// answer not read yet (preference not hydrated, or the full ATT re-check that
// runs at launch, on AppsFlyer's session-ready signal and after the app returns
// from the background).
export type AppsFlyerAttributionConsent = 'granted' | 'revoked' | 'undecided' | 'pending';

export function getAppsFlyerAttributionConsent(): AppsFlyerAttributionConsent {
  if (!DEV_KEY) return 'undecided';
  const enabled = analyticsPreference();
  if (enabled === false) return 'revoked';
  if (enabled === null) return 'pending';
  switch (trackingAuthorizationStatus) {
    case 'authorized':
      return 'granted';
    case 'notSupported':
      // ATT exists on every iOS version the app supports, so there this means
      // the tracking module didn't load: no answer to link with.
      return Platform.OS === 'ios' ? 'undecided' : 'granted';
    case 'denied':
      return 'revoked';
    case 'notDetermined':
      return 'undecided';
    default:
      return 'pending';
  }
}

export function subscribeAppsFlyerAttribution(listener: () => void): () => void {
  attributionListeners.add(listener);
  return (): void => {
    attributionListeners.delete(listener);
  };
}

// Listeners hear about consent changes, and about the SDK becoming ready, which
// is when the identifier becomes readable.
function publishAttributionState(sdkBecameReady = false): void {
  const consent = getAppsFlyerAttributionConsent();
  const consentChanged = consent !== 'pending' && consent !== lastPublishedConsent;
  if (consentChanged) lastPublishedConsent = consent;
  if (!consentChanged && !sdkBecameReady) return;
  attributionListeners.forEach((listener): void => {
    try {
      listener();
    } catch (error) {
      warn('attribution listener failed')(error);
    }
  });
}

// The identifier exists once the SDK is initialized, before its first session
// starts, so a purchase made right after the ATT prompt can still carry it. It
// is fixed for the install, so one successful read serves the rest of the app
// session. The read waits only for a pending stop or resume, never for start(),
// and a slow native lookup must not hold billing indefinitely. Null means "not
// available now", not a withdrawal: callers read consent separately.
export async function getAppsFlyerRevenueId(): Promise<string | null> {
  if (!didInit || !collectionAllowed()) return null;
  if (revenueId) return revenueId;
  const stateChange = sdkStateChange ?? Promise.resolve();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const id = await Promise.race([
      stateChange.then((): Promise<string | null> | null =>
        collectionAllowed() ? getAppsFlyer().getAppsFlyerUID() : null,
      ),
      new Promise<null>((resolve) => {
        timeout = setTimeout(() => resolve(null), REVENUE_ID_LOOKUP_TIMEOUT_MS);
      }),
    ]);
    revenueId = id?.trim() || null;
    return collectionAllowed() ? revenueId : null;
  } catch (error) {
    warn('revenue identifier lookup failed')(error);
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function getAppsFlyer(): AppsFlyerSdk {
  // Keep the native module off shared store import paths so non-native consumers
  // can load those stores without evaluating the SDK entrypoint.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return (require('react-native-appsflyer') as { default: AppsFlyerSdk }).default;
}

// AppsFlyer records install/app-open attribution and a small set of product
// milestones — never transcription content. Like Sentry, every interaction is
// gated behind the user's Usage Analytics preference: disabling the toggle
// stops the SDK immediately, re-enabling resumes it. A null result means the
// persisted preference has not hydrated yet, so no SDK interaction is allowed.
function analyticsPreference(): boolean | null {
  const config = useConfigStore.getState().config;
  return config === null ? null : (config.usageAnalyticsEnabled ?? true);
}

function warn(message: string): (error: unknown) => void {
  return (error: unknown) => console.warn(`[appsflyer] ${message}`, error);
}

function invokeSdk(operation: () => Promise<void>): Promise<void> {
  try {
    return operation();
  } catch (error) {
    return Promise.reject(error);
  }
}

function attributionAllowed(): boolean {
  return (
    trackingAuthorizationStatus === 'authorized' || trackingAuthorizationStatus === 'notSupported'
  );
}

function collectionAllowed(): boolean {
  return analyticsPreference() === true && attributionAllowed();
}

function startSessionIfAllowed(): void {
  if (!sessionReady || didStartCurrentSession || !collectionAllowed()) return;

  didStartCurrentSession = true;
  const startOperation = invokeSdk(() => getAppsFlyer().start())
    .then((): boolean => {
      if (sdkReady === startOperation) {
        flushPendingEvents();
        publishAttributionState(true);
      }
      return true;
    })
    .catch((error: unknown): boolean => {
      if (sdkReady === startOperation) {
        didStartCurrentSession = false;
        // The identifier is readable without a session, so a reader that gave
        // up while start() was pending can try again.
        publishAttributionState(true);
      }
      warn('start failed')(error);
      return false;
    });
  sdkReady = startOperation;
}

function sendEventWhenReady(eventName: string, eventValues: Record<string, unknown>): void {
  const readiness = sdkReady;
  if (!didInit || !readiness || !collectionAllowed()) return;
  const handleError = warn(`failed to log ${eventName}`);

  readiness.then((ready): void => {
    if (!ready || readiness !== sdkReady || !collectionAllowed()) return;
    invokeSdk(() => getAppsFlyer().logEvent({ eventName, eventValues })).catch(handleError);
  });
}

function flushPendingEvents(): void {
  if (!collectionAllowed() || !didStartCurrentSession || !sdkReady || pendingEvents.length === 0)
    return;
  const events = pendingEvents;
  pendingEvents = [];
  events.forEach(({ eventName, eventValues }): void => {
    sendEventWhenReady(eventName, eventValues);
  });
}

// SDK 7 startup model: init() registers the app, then native signals that the
// foreground session is ready. Start only while ATT and Usage Analytics both
// allow collection, including when either decision changes during that cycle.
function initSdk(devKey: string): void {
  didInit = true;
  const appsFlyer = getAppsFlyer();
  invokeSdk(() => appsFlyer.init({ devKey, appId: IOS_APP_ID })).catch(warn('init failed'));
  invokeSdk(() => appsFlyer.enableDebug({ enabled: __DEV__ })).catch(warn('enableDebug failed'));
  invokeSdk(() =>
    appsFlyer.registerSessionReadyListener(() => {
      sessionReady = true;
      didStartCurrentSession = false;
      refreshAppsFlyerTrackingAuthorization().catch(warn('ATT status refresh failed'));
    }),
  ).catch(warn('session-ready listener failed'));
}

function updateSdkStoppedState(shouldStop: boolean): Promise<boolean> {
  const update = (): Promise<void> => invokeSdk(() => getAppsFlyer().stop({ shouldStop }));
  const operation = sdkStateChange ? sdkStateChange.then(update) : update();
  const result = operation
    .then((): boolean => true)
    .catch((error: unknown): boolean => {
      warn('stop failed')(error);
      return false;
    });
  sdkStateChange = result.then((): void => undefined);
  return result;
}

function setSdkStopped(shouldStop: boolean): void {
  if (!didInit || shouldStop === stopped) return;

  stopped = shouldStop;
  const preferenceChange = updateSdkStoppedState(shouldStop);
  if (shouldStop) {
    sdkReady = null;
    return;
  }

  const readiness = preferenceChange.then((updated): boolean => {
    if (!updated || stopped) return false;
    startSessionIfAllowed();
    flushPendingEvents();
    return true;
  });
  sdkReady = readiness;
  readiness.then((ready): void => {
    // A resume that starts no session of its own (after the ATT re-check, or one
    // that superseded a pending start) still makes the identifier readable.
    if (ready && sdkReady === readiness) publishAttributionState(true);
  });
}

function applyAttributionPolicy(devKey: string): void {
  applyCollectionPolicy(devKey);
  // After the SDK state matches the policy, so listeners read the result.
  publishAttributionState();
}

function applyCollectionPolicy(devKey: string): void {
  const enabled = analyticsPreference();
  if (enabled === null) return;

  if (!enabled) {
    pendingEvents = [];
    setSdkStopped(true);
    return;
  }

  if (!attributionAllowed()) {
    if (trackingAuthorizationStatus === 'denied') pendingEvents = [];
    setSdkStopped(true);
    return;
  }

  if (!didInit) {
    initSdk(devKey);
    return;
  }

  setSdkStopped(false);
}

function applyTrackingAuthorizationStatus(status: TrackingAuthorizationStatus): void {
  trackingAuthorizationStatus = status;
  if (didSetUp && DEV_KEY) applyAttributionPolicy(DEV_KEY);
}

export function setAppsFlyerTrackingAuthorizationStatus(status: TrackingAuthorizationStatus): void {
  // A result obtained by the onboarding screen is newer than any startup check
  // already in flight, so invalidate that check before applying it.
  trackingRefreshRevision += 1;
  applyTrackingAuthorizationStatus(status);
}

export async function refreshAppsFlyerTrackingAuthorization(): Promise<void> {
  if (trackingAuthorizationStatus === 'notSupported') {
    startSessionIfAllowed();
    return;
  }

  const revision = ++trackingRefreshRevision;
  trackingAuthorizationStatus = null;
  if (didSetUp && DEV_KEY) applyAttributionPolicy(DEV_KEY);

  try {
    const status = await getTrackingAuthorizationStatus();
    if (revision !== trackingRefreshRevision) return;
    applyTrackingAuthorizationStatus(status);
  } catch (error) {
    if (revision !== trackingRefreshRevision) return;
    throw error;
  }
}

// A light re-read for a return from an inactive state, such as a permission
// prompt shown over the app (a paywall can ask for tracking). Unlike the full
// refresh it keeps the current status while reading, so nothing stops or reads
// as pending, and applies only a change. It also recovers a status left unread
// by a failed refresh.
export async function recheckAppsFlyerTrackingAuthorization(): Promise<void> {
  if (trackingAuthorizationStatus === 'notSupported') return;
  const revision = trackingRefreshRevision;
  const status = await getTrackingAuthorizationStatus();
  if (revision !== trackingRefreshRevision || status === trackingAuthorizationStatus) return;
  trackingRefreshRevision += 1;
  applyTrackingAuthorizationStatus(status);
}

export function initAppsFlyer(): void {
  if (didSetUp) return;
  didSetUp = true;

  if (!DEV_KEY) {
    console.warn(
      '[appsflyer] EXPO_PUBLIC_APPSFLYER_DEV_KEY is not configured; attribution is disabled.',
    );
    return;
  }

  useConfigStore.subscribe((): void => applyAttributionPolicy(DEV_KEY));
  refreshAppsFlyerTrackingAuthorization().catch(warn('ATT status refresh failed'));
}

// In-app events (trials, subscriptions, activation milestones). No-ops when
// the user has analytics disabled or the SDK never started.
export function logAppsFlyerEvent(
  eventName: string,
  eventValues: Record<string, unknown> = {},
): void {
  if (analyticsPreference() !== true) return;

  if (trackingAuthorizationStatus === 'denied') return;

  if (
    trackingAuthorizationStatus === null ||
    trackingAuthorizationStatus === 'notDetermined' ||
    !didStartCurrentSession ||
    !sdkReady
  ) {
    if (pendingEvents.length === MAX_PENDING_EVENTS) pendingEvents.shift();
    pendingEvents.push({ eventName, eventValues });
    return;
  }

  sendEventWhenReady(eventName, eventValues);
}

export function logTutorialCompletion({
  keyboardInstalled,
  microphonePermissionGranted,
}: TutorialCompletionInput): void {
  logAppsFlyerEvent('af_tutorial_completion', {
    af_success: true,
    keyboard_installed: keyboardInstalled,
    microphone_permission_granted: microphonePermissionGranted,
  });
}

export function logTranscriptionCompleted({
  source,
  provider,
}: TranscriptionCompletionInput): void {
  logAppsFlyerEvent('transcription_completed', { source, provider });
}

export function logPaywallViewed(placement: SuperwallPlacement): void {
  logAppsFlyerEvent('paywall_viewed', { placement });
}

export function logSubscription(productId: string, placement: SuperwallPlacement): void {
  // RevenueCat owns iOS purchase events and revenue, including renewals. Keep
  // this client-only UX milestone out of the existing af_subscribe mapping.
  logAppsFlyerEvent(Platform.OS === 'ios' ? 'subscription_completed' : 'af_subscribe', {
    af_subscription_id: productId,
    placement,
  });
}

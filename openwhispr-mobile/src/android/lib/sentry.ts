import * as Sentry from '@sentry/react-native';
import { useConfigStore } from '@/android/store/useConfigStore';
import { isUsageAnalyticsAllowed } from '@/android/shared/lib/usageAnalytics';
import { startDebugLogLifecycle } from '@/android/lib/debugLogLifecycle';

let didInit = false;
let watchingConsent = false;
let closing: Promise<void> | null = null;

// Consent is unknown until the stored preferences hydrate, so every channel
// fails closed until then. Once loaded, the saved preference (default on) is
// authoritative; the store applies withdrawal immediately, before saving it.
function analyticsEnabled(): boolean {
  return isUsageAnalyticsAllowed(useConfigStore.getState().config);
}

function syncConsent(): void {
  if (didInit && !analyticsEnabled()) {
    // Native crash, hang and watchdog handlers never pass through the JS
    // hooks below; closing the SDK tears them down too. Re-consent re-inits.
    didInit = false;
    closing = Sentry.close()
      .catch(() => {})
      .then(() => {
        closing = null;
        initSentry();
      });
    return;
  }
  initSentry();
}

/**
 * A tagged error report: the microphone was refused (with who held it) or the bubble's pipeline
 * timed out. Tags only, never a log line; `beforeSend` drops it without Usage analytics consent.
 */
const waitingReports: { kind: string; tags: Record<string, string> }[] = [];
export function reportNativeError(kind: string, tags: Record<string, string>): void {
  // Consent may still be loading; keep a few until Sentry starts (or drop them if it never does).
  if (!didInit) {
    if (waitingReports.length < 20) waitingReports.push({ kind, tags });
    return;
  }
  Sentry.captureMessage(kind, { level: 'error', tags: { android_error: kind, ...tags } });
}

export function initSentry(): void {
  startDebugLogLifecycle(reportNativeError);
  if (!watchingConsent) {
    watchingConsent = true;
    useConfigStore.subscribe(syncConsent);
  }
  // Shutdown closes the shared native SDK, so it must finish before re-init.
  if (didInit || closing) return;

  const dsn = process.env.EXPO_PUBLIC_SENTRY_DSN;
  if (!dsn) return;

  if (!analyticsEnabled()) return;

  Sentry.init({
    dsn,
    sendDefaultPii: false,
    // Crash and error reports only, as the privacy policy says: no log lines and
    // no screen replay, not even on error.
    enableLogs: false,
    replaysSessionSampleRate: 0,
    replaysOnErrorSampleRate: 0,
    beforeSend: (event) => (analyticsEnabled() ? event : null),
    beforeSendTransaction: (event) => (analyticsEnabled() ? event : null),
    beforeBreadcrumb: (breadcrumb) => (analyticsEnabled() ? breadcrumb : null),
  });

  didInit = true;
  waitingReports.splice(0).forEach(({ kind, tags }) => reportNativeError(kind, tags));
}

export { Sentry };

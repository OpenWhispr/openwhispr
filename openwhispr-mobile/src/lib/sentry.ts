import * as Sentry from '@sentry/react-native';
import { useConfigStore } from '@/store/useConfigStore';

let didInit = false;
let watchingConsent = false;
let closing: Promise<void> | null = null;

// Consent is unknown until the stored preferences hydrate, so every channel
// fails closed until then. Once loaded, the saved preference (default on) is
// authoritative — including while a later save is in flight.
function analyticsEnabled(): boolean {
  const { config } = useConfigStore.getState();
  return config !== null && (config.usageAnalyticsEnabled ?? true);
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

export function initSentry(): void {
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
    enableLogs: true,
    logsOrigin: 'js',
    replaysSessionSampleRate: 0,
    replaysOnErrorSampleRate: 1,
    integrations: [
      Sentry.mobileReplayIntegration({
        maskAllText: true,
        maskAllImages: true,
        maskAllVectors: true,
        beforeErrorSampling: () => analyticsEnabled(),
      }),
    ],
    beforeSend: (event) => (analyticsEnabled() ? event : null),
    beforeSendLog: (log) => (analyticsEnabled() ? log : null),
    beforeSendTransaction: (event) => (analyticsEnabled() ? event : null),
    beforeBreadcrumb: (breadcrumb) => (analyticsEnabled() ? breadcrumb : null),
  });

  didInit = true;
}

export { Sentry };

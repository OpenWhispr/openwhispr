import * as Network from 'expo-network';
import { AndroidDictation, dictationEvents } from '../../../modules/android-dictation/src';
import { debugLog, flushDebugLog, safeError } from './debugLog';

let started = false;

type ErrorHandler = (error: unknown, isFatal?: boolean) => void;
interface ErrorUtilsShape {
  getGlobalHandler(): ErrorHandler;
  setGlobalHandler(handler: ErrorHandler): void;
}

/**
 * Sends the native side's error reports (a refused microphone, a bubble pipeline timeout) to
 * Sentry as tagged messages. Sentry drops them itself without Usage analytics consent; they carry
 * tags only, never a log line.
 */
export function sendNativeErrorReports(
  capture: (kind: string, tags: Record<string, string>) => void,
): number {
  const reports = AndroidDictation?.takeErrorReports?.() ?? [];
  for (const { kind, ...tags } of reports) {
    if (kind) capture(kind, tags);
  }
  return reports.length;
}

/**
 * Once per JS runtime (the app and the bubble's headless task): JS errors, connectivity changes and
 * native error reports. Called from initSentry, which both startups run.
 */
export function startDebugLogLifecycle(
  capture: (kind: string, tags: Record<string, string>) => void,
): void {
  if (started) return;
  started = true;
  try {
    const utils = (globalThis as { ErrorUtils?: ErrorUtilsShape }).ErrorUtils;
    if (utils) {
      const previous = utils.getGlobalHandler();
      utils.setGlobalHandler((error, isFatal) => {
        try {
          debugLog(
            'err',
            'js_error',
            {
              class: error instanceof Error ? error.name : typeof error,
              error: safeError(error),
              fatal: !!isFatal,
            },
            'E',
          );
          flushDebugLog();
        } catch {
          /* ignore */
        }
        previous(error, isFatal);
      });
    }
    let online: boolean | null = null;
    Network.addNetworkStateListener((state) => {
      const next = state.isInternetReachable ?? state.isConnected ?? null;
      if (next === null || next === online) return;
      online = next;
      debugLog('net', next ? 'online' : 'offline', { type: state.type ? String(state.type) : undefined });
    });
    sendNativeErrorReports(capture);
    dictationEvents?.addListener('onErrorReport', () => sendNativeErrorReports(capture));
  } catch {
    /* The log must never break startup. */
  }
}

import type { AndroidDictation as NativeModule } from '../../../modules/android-dictation/src';
import {
  errorCode,
  formatLine,
  safeError,
  type DebugFields,
  type DebugLevel,
} from './debugLogFormat';

export {
  errorCode,
  hostOf,
  newRunId,
  routeOf,
  safeError,
  textHash,
  wordCount,
} from './debugLogFormat';
export type { DebugFields } from './debugLogFormat';

/**
 * The opt-in debug log's JS side (Settings › Analytics › Debug logging). Lines are formatted here
 * with the native rules (see debugLogFormat.ts) and handed to the android-dictation module, which
 * queues them for its writer thread; the module owns the file and the switch. Nothing is formatted while the switch is off.
 *
 * Log ids, codes, counts and durations only: never what anyone said, wrote or recorded, never a
 * file name, an email, a token or a key.
 */

let enabled: boolean | null = null;
let nativeModule: typeof NativeModule | undefined;

// Loaded on first use, so importing the logger (sessionFetch does) never loads a native module.
function native(): typeof NativeModule {
  if (nativeModule === undefined) {
    try {
      nativeModule = (
        require('../../../modules/android-dictation/src') as {
          AndroidDictation: typeof NativeModule;
        }
      ).AndroidDictation;
    } catch {
      nativeModule = null;
    }
  }
  return nativeModule;
}
let queue: string[] = [];

function readEnabled(): boolean {
  if (enabled === null) {
    try {
      enabled = native()?.isDebugLogging?.() ?? false;
    } catch {
      enabled = false;
    }
  }
  return enabled;
}

/** Whether lines are being kept. Cheap: read from native once, then cached. */
export function isDebugLogging(): boolean {
  return readEnabled();
}

export function flushDebugLog(): void {
  if (!queue.length) return;
  const lines = queue;
  queue = [];
  try {
    native()?.debugLog?.(lines);
  } catch {
    /* The log must never break the app. */
  }
}

export function debugLog(
  area: string,
  event: string,
  fields?: DebugFields,
  level: DebugLevel = 'I',
): void {
  if (!readEnabled()) return;
  queue.push(formatLine(new Date(), level, area, event, fields));
  // Written at once: the bubble's headless task stops JS timers when a dictation ends, so a
  // line left waiting for a timer could sit in the queue until the next one.
  flushDebugLog();
}

export const dlog = {
  info: (area: string, event: string, fields?: DebugFields) => debugLog(area, event, fields, 'I'),
  warn: (area: string, event: string, fields?: DebugFields) => debugLog(area, event, fields, 'W'),
  error: (area: string, event: string, fields?: DebugFields) => debugLog(area, event, fields, 'E'),
  /** An error's class, message (cut short) and code under `error` and `code`. */
  failure: (area: string, event: string, error: unknown, fields?: DebugFields) =>
    debugLog(
      area,
      event,
      { ...fields, error: safeError(error), code: fields?.code ?? errorCode(error) },
      'E',
    ),
};

/** Turns the log on or off; the switch lives in native so the bubble logs without JS. */
export function setDebugLogging(on: boolean): void {
  if (!on) flushDebugLog();
  native()?.setDebugLogging?.(on);
  enabled = on;
}

/** Times an attempt: `const t = startTimer(); … t()` gives the milliseconds since. */
export function startTimer(): () => number {
  const started = Date.now();
  return () => Date.now() - started;
}

/** For tests: forget the cached switch and drop queued lines. */
export function resetDebugLogForTests(value: boolean | null = null): void {
  enabled = value;
  queue = [];
}

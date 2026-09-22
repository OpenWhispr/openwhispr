import { useEffect, useState } from 'react';
import { safeHaptics } from '@/lib/utils';
import { APP_GROUP_KEYS, AppGroupStorage } from '../../modules/app-group-storage/src';

// How long the caller's confirmation stays up before `onConfirmed` runs.
export const KEYBOARD_HEARTBEAT_CONFIRM_MS = 2200;
const POLL_INTERVAL_MS = 250;

// Normalised at the source so a corrupt value reads as "no heartbeat" rather than
// NaN, which fails every comparison and would slip past the guard below to report
// a keyboard that never appeared.
function readHeartbeat(): number {
  const parsed = Number(AppGroupStorage.getItem(APP_GROUP_KEYS.KEYBOARD_SHOWN_AT_MS) ?? '0');
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Watches for the OpenWhispr keyboard appearing. The extension stamps
 * KEYBOARD_SHOWN_AT_MS on every appearance and that write only lands with Full
 * Access granted, so a value newer than the one present at mount proves both that
 * the keyboard was raised and that the permission is live.
 *
 * Returns whether it has been seen so the caller can show its own confirmation;
 * `onConfirmed` fires once that confirmation has had time to be read. False
 * negatives are expected — the user may never raise the keyboard — so every
 * caller must keep a manual way forward.
 */
export function useKeyboardHeartbeat(onConfirmed: () => void): boolean {
  const [detected, setDetected] = useState(false);

  useEffect(() => {
    const baseline = readHeartbeat();
    let confirmTimer: ReturnType<typeof setTimeout> | null = null;

    const poll = setInterval(() => {
      if (readHeartbeat() <= baseline) return;
      clearInterval(poll);
      safeHaptics('success');
      setDetected(true);
      confirmTimer = setTimeout(onConfirmed, KEYBOARD_HEARTBEAT_CONFIRM_MS);
    }, POLL_INTERVAL_MS);

    return () => {
      clearInterval(poll);
      if (confirmTimer) clearTimeout(confirmTimer);
    };
  }, [onConfirmed]);

  return detected;
}

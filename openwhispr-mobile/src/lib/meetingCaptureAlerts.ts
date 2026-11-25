import { useEffect } from 'react';
import { Alert, AppState, Platform } from 'react-native';
import { getNotificationStatus } from '@/lib/notifications';
import {
  PARTIAL_CAPTURE_TITLE,
  meetingCaptureAlert,
  partialCaptureMessage,
  type CaptureCoverage,
  type MeetingCaptureAlertInput,
} from '@/lib/notes/meetingCapture';

// When capture pauses while the app is inactive (a call arriving, Siri), long enough that a brief
// interruption resumes before it fires and the notification is cancelled; short enough to reach
// the user while the meeting is on. Any other pause notifies as soon as the app is in the
// background: another app has the microphone and only the user reopening OpenWhispr reliably
// gets it back.
const CAPTURE_PAUSED_DELAY_SECONDS = 20;

const CAPTURE_PAUSED_TITLE = 'Meeting recording paused';
const CAPTURE_PAUSED_BODY = 'Open OpenWhispr to resume recording.';

type NotificationsModule = typeof import('expo-notifications');

// Loaded lazily, like `@/lib/notifications`: builds without the native module must not crash
// on import.
function loadNotifications(): NotificationsModule | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require('expo-notifications') as NotificationsModule;
  } catch {
    return null;
  }
}

/**
 * Schedules "recording paused" `delaySeconds` out (at once for 0). Null when the app is active or
 * notifications are not granted. Never asks for permission.
 */
export async function scheduleCapturePausedNotification(
  delaySeconds: number = CAPTURE_PAUSED_DELAY_SECONDS,
): Promise<string | null> {
  // iOS only: Android never raised this notice and keeps behaving as before.
  if (Platform.OS !== 'ios') return null;
  if (AppState.currentState === 'active') return null;
  if ((await getNotificationStatus()) !== 'granted') return null;
  const notifications = loadNotifications();
  if (!notifications) return null;
  try {
    return await notifications.scheduleNotificationAsync({
      content: { title: CAPTURE_PAUSED_TITLE, body: CAPTURE_PAUSED_BODY },
      trigger:
        delaySeconds > 0
          ? {
              type: notifications.SchedulableTriggerInputTypes.TIME_INTERVAL,
              seconds: delaySeconds,
            }
          : null,
    });
  } catch {
    return null;
  }
}

/** Cancels the notification if it is still scheduled and removes it if it was delivered. */
export async function cancelCapturePausedNotification(id: string | null): Promise<void> {
  if (id == null) return;
  const notifications = loadNotifications();
  if (!notifications) return;
  try {
    await notifications.cancelScheduledNotificationAsync(id);
  } catch {
    // Already delivered or gone; there is nothing left to cancel.
  }
  try {
    await notifications.dismissNotificationAsync(id);
  } catch {
    // Never delivered, or already dismissed.
  }
}

/**
 * While `active` and not `capturing`, raises one "recording paused" notification per pause.
 * A pause that begins while the app is active or in the background notifies as soon as the app is
 * in the background. A pause that begins while the app is inactive (a call arriving makes the app
 * inactive a moment before capture stops, as does Siri) waits 20 s from the pause, so a declined
 * call resumes first. Coming back before it fires cancels it; capture resuming, the recording
 * ending and unmounting cancel or remove it.
 */
export function useCapturePausedNotification(active: boolean, capturing: boolean): void {
  useEffect(() => {
    if (!active || capturing) return;
    const pausedAtMs = Date.now();
    const pausedWhileInactive = AppState.currentState === 'inactive';
    let disposed = false;
    let pending = false;
    let scheduledId: string | null = null;
    let firesAtMs = 0;
    // This pause's notification has been delivered; it is not raised again.
    let delivered = false;

    const delaySeconds = (): number => {
      if (!pausedWhileInactive) return 0;
      const remainingMs = pausedAtMs + CAPTURE_PAUSED_DELAY_SECONDS * 1000 - Date.now();
      return remainingMs > 0 ? Math.ceil(remainingMs / 1000) : 0;
    };

    const cancel = (): void => {
      const id = scheduledId;
      scheduledId = null;
      cancelCapturePausedNotification(id).catch(() => undefined);
    };

    // Back in the foreground: a notification still waiting is cancelled; one already shown
    // stays until capture resumes or the recording ends, and is never shown twice.
    const returnedToForeground = (): void => {
      if (scheduledId == null) return;
      if (Date.now() >= firesAtMs) {
        delivered = true;
        return;
      }
      cancel();
    };

    const schedule = (): void => {
      if (pending || delivered || scheduledId != null) return;
      pending = true;
      const delay = delaySeconds();
      scheduleCapturePausedNotification(delay)
        .then((id) => {
          pending = false;
          // The user may be back, or capture may have resumed, while it was being scheduled.
          if (disposed || AppState.currentState === 'active') {
            cancelCapturePausedNotification(id).catch(() => undefined);
            return;
          }
          scheduledId = id;
          firesAtMs = Date.now() + delay * 1000;
        })
        .catch(() => {
          // A failed permission read schedules nothing; leaving the foreground again retries.
          pending = false;
        });
    };

    schedule();
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') returnedToForeground();
      // Going inactive (Control Center, a call screen) is still on screen; an inactive pause
      // scheduled its notification when it began, so this only retries a failed schedule.
      else if (state === 'background' || pausedWhileInactive) schedule();
    });
    return () => {
      disposed = true;
      subscription.remove();
      cancel();
    };
  }, [active, capturing]);
}

/** Tells the user, once the note is open, how much of a partly recorded meeting was kept. */
export function alertIfPartialCapture(coverage: CaptureCoverage): void {
  if (!coverage.isPartial) return;
  Alert.alert(PARTIAL_CAPTURE_TITLE, partialCaptureMessage(coverage));
}

/** A finished cloud meeting's alert, once the note is open, when part of it is missing. */
export function alertCloudMeetingCapture(input: MeetingCaptureAlertInput): void {
  const alert = meetingCaptureAlert(input);
  if (alert) Alert.alert(alert.title, alert.message);
}

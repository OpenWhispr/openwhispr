import { useEffect } from 'react';
import { Alert, AppState, Platform } from 'react-native';
import { getNotificationStatus } from '@/lib/notifications';
import {
  OWED_CAPTURE_TITLE,
  PARTIAL_CAPTURE_TITLE,
  owedCaptureMessage,
  partialCaptureMessage,
  type CaptureCoverage,
} from '@/lib/notes/meetingCapture';

// Long enough that a brief interruption (Siri, a declined call) resumes before it fires and
// the notification is cancelled; short enough to reach the user while the meeting is on.
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

/** Schedules "recording paused" 20 s out. Null when the app is active or notifications are not granted. Never asks for permission. */
export async function scheduleCapturePausedNotification(): Promise<string | null> {
  // iOS only: Android never raised this notice and keeps behaving as before.
  if (Platform.OS !== 'ios') return null;
  if (AppState.currentState === 'active') return null;
  if ((await getNotificationStatus()) !== 'granted') return null;
  const notifications = loadNotifications();
  if (!notifications) return null;
  try {
    return await notifications.scheduleNotificationAsync({
      content: { title: CAPTURE_PAUSED_TITLE, body: CAPTURE_PAUSED_BODY },
      trigger: {
        type: notifications.SchedulableTriggerInputTypes.TIME_INTERVAL,
        seconds: CAPTURE_PAUSED_DELAY_SECONDS,
      },
    });
  } catch {
    return null;
  }
}

export async function cancelCapturePausedNotification(id: string | null): Promise<void> {
  if (id == null) return;
  const notifications = loadNotifications();
  if (!notifications) return;
  try {
    await notifications.cancelScheduledNotificationAsync(id);
  } catch {
    // Already delivered or gone; there is nothing left to cancel.
  }
}

/**
 * While `active` and not `capturing`, keeps a "recording paused" notification scheduled
 * whenever the app is out of the foreground. Capture can stop a moment before the app leaves
 * the foreground (a call arriving), so leaving the foreground schedules it too; coming back,
 * capture resuming, the recording ending and unmounting all cancel it.
 */
export function useCapturePausedNotification(active: boolean, capturing: boolean): void {
  useEffect(() => {
    if (!active || capturing) return;
    let disposed = false;
    let pending = false;
    let scheduledId: string | null = null;

    const cancel = (): void => {
      const id = scheduledId;
      scheduledId = null;
      cancelCapturePausedNotification(id).catch(() => undefined);
    };

    const schedule = (): void => {
      if (pending || scheduledId != null) return;
      pending = true;
      scheduleCapturePausedNotification()
        .then((id) => {
          pending = false;
          // The user may be back, or capture may have resumed, while it was being scheduled.
          if (disposed || AppState.currentState === 'active') {
            cancelCapturePausedNotification(id).catch(() => undefined);
            return;
          }
          scheduledId = id;
        })
        .catch(() => {
          // A failed permission read schedules nothing; leaving the foreground again retries.
          pending = false;
        });
    };

    schedule();
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') cancel();
      else schedule();
    });
    return () => {
      disposed = true;
      subscription.remove();
      cancel();
    };
  }, [active, capturing]);
}

/**
 * Tells the user, once the note is open, how much of a partly recorded meeting was kept. With
 * `owed`, the coverage counts what is transcribed so far and the rest is still on its way.
 */
export function alertIfPartialCapture(
  coverage: CaptureCoverage,
  options: { owed?: boolean } = {},
): void {
  if (!coverage.isPartial) return;
  if (options.owed) {
    Alert.alert(OWED_CAPTURE_TITLE, owedCaptureMessage(coverage));
    return;
  }
  Alert.alert(PARTIAL_CAPTURE_TITLE, partialCaptureMessage(coverage));
}

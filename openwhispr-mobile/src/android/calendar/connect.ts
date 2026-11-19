import { create } from 'zustand';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useAuthStore } from '@/store/useAuthStore';
import { useGoogleCalendarStore } from '@/store/useGoogleCalendarStore';
import type { GoogleCalendarAccount } from '@/data/calendarTypes';
import { getGoogleCalendarClientId } from '@/services/calendar/googleCalendarConfig';
import { GoogleCalendarAuthError } from '@/services/calendar/googleCalendarAuth';
import { authorizeGoogleCalendarOnAndroid } from '@/services/calendar/googleCalendarAndroidAuth';
import { captureGoogleCalendarException } from '@/services/calendar/googleCalendarTelemetry';
import { requiresRealAccount } from '@/lib/accountAccess';

/**
 * Connecting Google Calendar on Android (Figma C2 and 19.3): Google's own account and consent
 * sheet from Play services, then the same store iOS uses, so Notes and Settings read one
 * connection. The build opts in by carrying the Android OAuth client's ID; Google matches the
 * app to that client by package and signing certificate.
 */
export type ConnectOutcome = 'connected' | 'cancelled' | 'unavailable' | 'signedOut' | 'failed';

export function calendarConnectAvailable(): boolean {
  return getGoogleCalendarClientId() != null;
}

export async function connectGoogleCalendar(): Promise<ConnectOutcome> {
  const user = useAuthStore.getState().user;
  if (!user || requiresRealAccount(user)) return 'signedOut';
  if (!getGoogleCalendarClientId()) return 'unavailable';
  const store = useGoogleCalendarStore.getState();
  store.setAuthSessionActive(true);
  try {
    const authorization = await authorizeGoogleCalendarOnAndroid();
    await store.connectAuthorized(authorization);
    return 'connected';
  } catch (error) {
    // Closing Google's sheet goes back quietly (C2 → C1), no error dialog.
    if (error instanceof GoogleCalendarAuthError && error.code === 'cancelled') return 'cancelled';
    captureGoogleCalendarException(error, 'oauth_connect_ui');
    return 'failed';
  } finally {
    useGoogleCalendarStore.getState().setAuthSessionActive(false);
  }
}

export function needsReconnect(account: GoogleCalendarAccount): boolean {
  return account.status === 'needs_reconnect' || account.status === 'error';
}

const DISMISSED_KEY = 'android.notes.calendarPromptDismissed';

/** C4: × hides the Notes prompt for good on this phone; a later disconnect doesn't undo it. */
export const useCalendarPromptDismissed = create<{ dismissed: boolean | null }>(() => ({
  dismissed: null,
}));

let loaded = false;
export function loadCalendarPromptDismissed() {
  if (loaded) return;
  loaded = true;
  AsyncStorage.getItem(DISMISSED_KEY)
    .then((value) => useCalendarPromptDismissed.setState({ dismissed: value === '1' }))
    .catch(() => useCalendarPromptDismissed.setState({ dismissed: false }));
}

export function dismissCalendarPrompt() {
  useCalendarPromptDismissed.setState({ dismissed: true });
  AsyncStorage.setItem(DISMISSED_KEY, '1').catch(() => undefined);
}

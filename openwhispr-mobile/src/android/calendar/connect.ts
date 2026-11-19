import * as WebBrowser from 'expo-web-browser';
import { create } from 'zustand';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useAuthStore } from '@/store/useAuthStore';
import { useGoogleCalendarStore } from '@/store/useGoogleCalendarStore';
import type { GoogleCalendarAccount } from '@/data/calendarTypes';
import {
  GOOGLE_AUTH_DISCOVERY,
  getGoogleCalendarClientId,
} from '@/services/calendar/googleCalendarConfig';
import { buildGoogleCalendarAuthRequest } from '@/services/calendar/googleCalendarAuth';
import { captureGoogleCalendarException } from '@/services/calendar/googleCalendarTelemetry';
import { requiresRealAccount } from '@/lib/accountAccess';

WebBrowser.maybeCompleteAuthSession();

/**
 * Connecting Google Calendar on Android (Figma C2 and 19.3): Google's sign-in in a Chrome tab,
 * then the same store iOS uses, so Notes and Settings read one connection.
 */
export type ConnectOutcome = 'connected' | 'cancelled' | 'unavailable' | 'signedOut' | 'failed';

export function calendarConnectAvailable(): boolean {
  return getGoogleCalendarClientId() != null;
}

export async function connectGoogleCalendar(): Promise<ConnectOutcome> {
  const user = useAuthStore.getState().user;
  if (!user || requiresRealAccount(user)) return 'signedOut';
  const clientId = getGoogleCalendarClientId();
  if (!clientId) return 'unavailable';
  const store = useGoogleCalendarStore.getState();
  const request = buildGoogleCalendarAuthRequest(clientId);
  store.setAuthSessionActive(true);
  try {
    const result = await request.promptAsync(GOOGLE_AUTH_DISCOVERY);
    // Closing the tab or refusing goes back quietly (C2 → C1), no error dialog.
    if (result.type !== 'success') {
      if (result.type === 'error')
        captureGoogleCalendarException(
          result.error ?? new Error('Google Calendar authorization failed'),
          'oauth_prompt',
        );
      return 'cancelled';
    }
    const code = result.params.code;
    if (!code || !request.codeVerifier) return 'failed';
    await store.connect({
      clientId,
      code,
      codeVerifier: request.codeVerifier,
      redirectUri: request.redirectUri,
    });
    return 'connected';
  } catch (error) {
    captureGoogleCalendarException(error, 'oauth_connect_ui');
    return 'failed';
  } finally {
    useGoogleCalendarStore.getState().setAuthSessionActive(false);
  }
}

/** C2's Cancel: closes Google's tab, which ends the sign-in as cancelled. */
export function cancelGoogleCalendarConnect() {
  try {
    WebBrowser.dismissAuthSession();
  } catch {
    // Nothing open.
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

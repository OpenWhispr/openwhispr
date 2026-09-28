import { EventEmitter, requireNativeModule } from 'expo';
import { Platform } from 'react-native';

type EventSubscription = {
  remove(): void;
};

interface LiveActivityNativeModule {
  startSession(): void;
  endSession(): void;
  setDictationMode(enabled: boolean): void;
  isDictationModeEnabled(): boolean;
  startMeeting(title: string | null, startedAtMs: number): void;
  setMeetingProcessing(recordedSeconds: number): void;
  endMeeting(): void;
}

type LiveActivityEvents = {
  onEndMeetingRequested: () => void;
};

const NativeModule: LiveActivityNativeModule | null =
  Platform.OS === 'ios' ? requireNativeModule('LiveActivity') : null;

const NativeModuleEvents = NativeModule
  ? new EventEmitter<LiveActivityEvents>(NativeModule as any)
  : null;

const INERT_SUBSCRIPTION: EventSubscription = { remove: () => {} };

// ActivityKit caps the whole content state at 4 KB; a pasted calendar title must
// not push the card past it.
const MAX_MEETING_TITLE_LENGTH = 200;

/** A blank calendar title renders the default "Taking notes…" headline. */
export function normalizeMeetingTitle(title: string | null | undefined): string | null {
  const trimmed = title?.trim();
  if (!trimmed) return null;
  // Code points, so the cut never splits an emoji's surrogate pair.
  const chars = Array.from(trimmed);
  return chars.length > MAX_MEETING_TITLE_LENGTH
    ? `${chars
        .slice(0, MAX_MEETING_TITLE_LENGTH - 1)
        .join('')
        .trimEnd()}…`
    : trimmed;
}

export const LiveActivity = {
  /** Start the session Live Activity (no-op unless dictation mode is on, app is
   *  foreground, iOS 16.2+, and none is already running). */
  startSession(): void {
    NativeModule?.startSession();
  },
  /** End the session Live Activity immediately. Ignored while a meeting owns it. */
  endSession(): void {
    NativeModule?.endSession();
  },
  /** Enable/disable dictation mode. Enabling (while foreground) starts the
   *  activity; disabling ends it. Persisted in the app group. */
  setDictationMode(enabled: boolean): void {
    NativeModule?.setDictationMode(enabled);
  },
  /** Current dictation-mode flag (false off iOS). */
  isDictationModeEnabled(): boolean {
    return NativeModule?.isDictationModeEnabled() ?? false;
  },
  /** Show the meeting card. Must be called while the app is foreground (the
   *  meeting screen), since iOS only starts Live Activities from the foreground. */
  startMeeting({ title, startedAt }: { title: string | null; startedAt: number }): void {
    NativeModule?.startMeeting(normalizeMeetingTitle(title), startedAt);
  },
  /** Switch the meeting card to "Processing notes…". */
  setMeetingProcessing({ recordedSeconds }: { recordedSeconds: number }): void {
    NativeModule?.setMeetingProcessing(Math.max(0, Math.floor(recordedSeconds)));
  },
  /** Release the card back to the dictation session, or end it. */
  endMeeting(): void {
    NativeModule?.endMeeting();
  },
  /** Fires when the user taps End on the lock screen / Dynamic Island. */
  addEndMeetingListener(listener: () => void): EventSubscription {
    return NativeModuleEvents?.addListener('onEndMeetingRequested', listener) ?? INERT_SUBSCRIPTION;
  },
};

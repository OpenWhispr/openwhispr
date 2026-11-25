/**
 * A module-level view of the running meeting for callers that are not React: sign-out and account
 * deletion must settle a meeting before credentials go, and the warm-resume logic must not send the
 * user Home mid-meeting. Kept free of React and data imports so the auth store can use it without
 * an import cycle; the session provider registers itself here.
 */
export interface ActiveMeetingHandle {
  isActive: () => boolean;
  stop: () => Promise<void>;
}

let handle: ActiveMeetingHandle | null = null;

export function registerActiveMeeting(next: ActiveMeetingHandle | null): void {
  handle = next;
}

export function isMeetingActive(): boolean {
  return handle?.isActive() ?? false;
}

/** No-op when idle; otherwise resolves once the registered handle says the meeting has settled. */
export function stopActiveMeeting(): Promise<void> {
  if (handle == null || !handle.isActive()) return Promise.resolve();
  return handle.stop();
}

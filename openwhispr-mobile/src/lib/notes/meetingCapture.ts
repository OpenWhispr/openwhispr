/**
 * Pure decisions for a cloud meeting's recording state, kept out of `useCloudMeeting`
 * so they can be unit-tested without React.
 */

export type CloudMeetingStatus = 'connecting' | 'live' | 'reconnecting' | 'interrupted' | 'error';

/**
 * A stopped microphone outranks a reconnecting socket: audio the mic never heard is
 * lost for good, while audio held during a reconnect is still sent once it returns.
 */
export function deriveCloudMeetingStatus(input: {
  started: boolean;
  failed: boolean;
  capturing: boolean;
  reconnecting: boolean;
}): CloudMeetingStatus {
  if (input.failed) return 'error';
  if (!input.started) return 'connecting';
  if (!input.capturing) return 'interrupted';
  if (input.reconnecting) return 'reconnecting';
  return 'live';
}

// Frames arrive every ~100 ms, so five seconds without growth means the mic has
// stopped even if the native module never said so.
export const CAPTURE_STALL_MS = 5000;

/** True when the captured clock has not advanced for CAPTURE_STALL_MS. */
export function isCaptureStalled(lastGrowthAtMs: number, nowMs: number): boolean {
  return nowMs - lastGrowthAtMs >= CAPTURE_STALL_MS;
}

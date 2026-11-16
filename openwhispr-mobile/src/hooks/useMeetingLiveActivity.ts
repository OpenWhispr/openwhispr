import { useEffect, useRef } from 'react';
import { LiveActivity } from '../../modules/live-activity/src';

export type MeetingActivityPhase = 'idle' | 'recording' | 'processing';

interface UseMeetingLiveActivityOptions {
  phase: MeetingActivityPhase;
  title: string | null;
  /** Epoch ms. Read only when `phase` enters 'recording'. */
  startedAt: number | null;
  /** Called when the user taps End on the lock screen while recording. */
  onEndRequested: () => void;
}

/**
 * Mirrors a meeting's phase into the iOS Live Activity and forwards the
 * lock-screen End button. A no-op off iOS (the module is inert there).
 */
export function useMeetingLiveActivity({
  phase,
  title,
  startedAt,
  onEndRequested,
}: UseMeetingLiveActivityOptions): void {
  const latestRef = useRef({ phase, title, startedAt, onEndRequested });
  // Non-null while this hook has a meeting card up.
  const activeStartedAtRef = useRef<number | null>(null);
  // One End per meeting: iOS or a racing in-app Stop can deliver it twice before
  // the screen re-renders into 'processing'.
  const endRequestedRef = useRef(false);

  // Declared first so later effects in the same commit read fresh values.
  useEffect(() => {
    latestRef.current = { phase, title, startedAt, onEndRequested };
  });

  useEffect(() => {
    if (phase === 'recording') {
      if (activeStartedAtRef.current != null) return;
      const start = latestRef.current.startedAt ?? Date.now();
      activeStartedAtRef.current = start;
      endRequestedRef.current = false;
      LiveActivity.startMeeting({ title: latestRef.current.title, startedAt: start });
      return;
    }
    if (activeStartedAtRef.current == null) return;
    if (phase === 'processing') {
      LiveActivity.setMeetingProcessing({
        recordedSeconds: (Date.now() - activeStartedAtRef.current) / 1000,
      });
      return;
    }
    activeStartedAtRef.current = null;
    LiveActivity.endMeeting();
  }, [phase]);

  useEffect(() => {
    const subscription = LiveActivity.addEndMeetingListener(() => {
      if (latestRef.current.phase !== 'recording' || endRequestedRef.current) return;
      endRequestedRef.current = true;
      latestRef.current.onEndRequested();
    });
    return () => {
      subscription.remove();
      if (activeStartedAtRef.current != null) {
        activeStartedAtRef.current = null;
        LiveActivity.endMeeting();
      }
    };
  }, []);
}

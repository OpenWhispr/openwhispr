import { useCallback, useEffect, useRef, useState } from 'react';
import {
  startRealtimeMeetingWs,
  type RealtimeSession,
  type RealtimeUtterance,
} from '@/services/transcription/RealtimeMeetingWsService';
import {
  deriveCloudMeetingStatus,
  initialCloudMeetingSession,
  trackCaptureGrowth,
  type CloudMeetingStatus,
} from '@/lib/notes/meetingCapture';

export type { CloudMeetingStatus } from '@/lib/notes/meetingCapture';

export interface CloudMeeting {
  status: CloudMeetingStatus;
  error: string | null;
  partialText: string;
  utterances: RealtimeUtterance[];
  elapsedSeconds: number;
  /** Audio the mic actually delivered, in seconds. */
  capturedSeconds: number;
  /** Audio lost because no socket could take it during an outage, in seconds. */
  droppedSeconds: number;
  /** Times the mic stopped delivering audio. */
  interruptions: number;
  /** Times the socket dropped and had to reconnect. */
  reconnects: number;
  /** Stops the session, waits for the last turn, and returns every finalized utterance. */
  stop: () => Promise<RealtimeUtterance[]>;
}

/**
 * Owns a cloud realtime transcription session for a meeting. Starts the WebSocket
 * + native-PCM session when `enabled` becomes true, streams partial/finalized
 * utterances into state, and tracks elapsed and captured time. Lives in
 * `MeetingRecordScreen` (not the presentational recording component) so the screen's
 * finish handler can call `stop()` and read the final utterances/elapsed to persist them.
 */
export function useCloudMeeting({
  enabled,
  language,
  onUtterance,
}: {
  enabled: boolean;
  language?: string;
  onUtterance?: (utterance: RealtimeUtterance, index: number, capturedMs: number) => void;
}): CloudMeeting {
  const [initial] = useState(() => initialCloudMeetingSession(Date.now()));
  const [started, setStarted] = useState(initial.started);
  const [failed, setFailed] = useState(initial.failed);
  const [capturing, setCapturing] = useState(initial.capturing);
  const [stalled, setStalled] = useState(initial.stalled);
  const [reconnecting, setReconnecting] = useState(initial.reconnecting);
  const [error, setError] = useState<string | null>(initial.error);
  const [partialText, setPartialText] = useState(initial.partialText);
  const [utterances, setUtterances] = useState<RealtimeUtterance[]>(initial.utterances);
  const [elapsedSeconds, setElapsedSeconds] = useState(initial.elapsedSeconds);
  const [capturedSeconds, setCapturedSeconds] = useState(initial.capturedSeconds);
  const [droppedSeconds, setDroppedSeconds] = useState(initial.droppedSeconds);
  const [interruptions, setInterruptions] = useState(initial.interruptions);
  const [reconnects, setReconnects] = useState(initial.reconnects);

  const sessionRef = useRef<RealtimeSession | null>(null);
  const startedAtRef = useRef<number | null>(null);
  const stoppedRef = useRef(false);
  // Bumped per recording so a previous session still draining its last turn can't write
  // into the next one.
  const generationRef = useRef(0);
  const utteranceCountRef = useRef(initial.utteranceCount);
  const clockRef = useRef(initial.clock);
  const micCapturingRef = useRef(initial.capturing);
  const onUtteranceRef = useRef(onUtterance);
  onUtteranceRef.current = onUtterance;

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    // The session itself, kept here because `stop()` clears sessionRef before the last
    // turn has drained and that turn still needs its captured time.
    let liveSession: RealtimeSession | null = null;
    const generation = generationRef.current + 1;
    generationRef.current = generation;
    const fresh = initialCloudMeetingSession(Date.now());
    stoppedRef.current = false;
    startedAtRef.current = null;
    utteranceCountRef.current = fresh.utteranceCount;
    clockRef.current = fresh.clock;
    micCapturingRef.current = fresh.capturing;
    setStarted(fresh.started);
    setFailed(fresh.failed);
    setCapturing(fresh.capturing);
    setStalled(fresh.stalled);
    setReconnecting(fresh.reconnecting);
    setError(fresh.error);
    setPartialText(fresh.partialText);
    setUtterances(fresh.utterances);
    setElapsedSeconds(fresh.elapsedSeconds);
    setCapturedSeconds(fresh.capturedSeconds);
    setDroppedSeconds(fresh.droppedSeconds);
    setInterruptions(fresh.interruptions);
    setReconnects(fresh.reconnects);
    const isCurrent = (): boolean => generationRef.current === generation;
    const isLive = (): boolean => isCurrent() && !stoppedRef.current;
    startRealtimeMeetingWs(
      { language },
      {
        onPartial: (text) => {
          if (isLive()) setPartialText(text);
        },
        onUtterance: (utterance) => {
          // Still delivered while Stop drains the last turn, so it is saved too.
          if (!isCurrent()) return;
          const index = utteranceCountRef.current;
          utteranceCountRef.current += 1;
          setUtterances((prev) => [...prev, utterance]);
          setPartialText('');
          onUtteranceRef.current?.(utterance, index, liveSession?.capturedMs() ?? 0);
        },
        onError: (e) => {
          // Recorded for display only: the reducer forwards non-fatal server errors too, and
          // only an ended session (onClose, or a start that failed) is an error state.
          if (!isLive()) return;
          const message = (e as { error?: { message?: string } })?.error?.message;
          setError(typeof message === 'string' ? message : 'Transcription error');
        },
        onClose: () => {
          // A close we didn't initiate means the session ended.
          if (isLive()) setFailed(true);
        },
        onReconnecting: () => {
          if (!isLive()) return;
          setPartialText('');
          setReconnecting(true);
          setReconnects((n) => n + 1);
        },
        onReconnected: () => {
          if (isLive()) setReconnecting(false);
        },
        onCaptureState: ({ capturing: next }) => {
          if (isLive()) setCapturing(next);
        },
      },
    )
      .then((session) => {
        if (cancelled) {
          void session.stop();
          return;
        }
        liveSession = session;
        sessionRef.current = session;
        const now = Date.now();
        startedAtRef.current = now;
        // Startup can take seconds; the stall clock starts when capture does.
        clockRef.current = { ...clockRef.current, lastGrowthAtMs: now };
        setStarted(true);
      })
      .catch((e) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
        setFailed(true);
      });

    return () => {
      cancelled = true;
      stoppedRef.current = true;
      void sessionRef.current?.stop();
      sessionRef.current = null;
    };
    // Start once when enabled; language is captured at start and never re-triggers.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]);

  useEffect(() => {
    // Keep ticking through reconnects and interruptions: the wall clock feeds the
    // segment-timing fallback, and the captured clock is how a silent stall is noticed.
    if (!started || failed) return;
    const update = (): void => {
      const session = sessionRef.current;
      const startedAt = startedAtRef.current;
      if (!session || startedAt == null) return;
      const now = Date.now();
      const capturedMs = session.capturedMs();
      const growth = trackCaptureGrowth(clockRef.current, capturedMs, now);
      clockRef.current = growth.clock;
      setStalled(growth.stalled);
      setElapsedSeconds(Math.floor((now - startedAt) / 1000));
      setCapturedSeconds(Math.floor(capturedMs / 1000));
      setDroppedSeconds(Math.floor(session.droppedMs() / 1000));
    };
    update();
    const interval = setInterval(update, 1000);
    return () => clearInterval(interval);
  }, [started, failed]);

  // The native event and the stall check can both report one interruption; count it once.
  const micCapturing = capturing && !stalled;
  useEffect(() => {
    if (started && micCapturingRef.current && !micCapturing) {
      setInterruptions((n) => n + 1);
    }
    micCapturingRef.current = micCapturing;
  }, [started, micCapturing]);

  const stop = useCallback(async (): Promise<RealtimeUtterance[]> => {
    stoppedRef.current = true;
    const session = sessionRef.current;
    sessionRef.current = null;
    if (!session) return [];
    await session.stop();
    return session.utterances();
  }, []);

  const status = deriveCloudMeetingStatus({
    started,
    failed,
    capturing: micCapturing,
    reconnecting,
  });

  return {
    status,
    error,
    partialText,
    utterances,
    elapsedSeconds,
    capturedSeconds,
    droppedSeconds,
    interruptions,
    reconnects,
    stop,
  };
}

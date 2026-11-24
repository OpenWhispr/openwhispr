import { useCallback, useEffect, useRef, useState } from 'react';
import {
  startRealtimeMeetingWs,
  type RealtimeSession,
  type RealtimeUtterance,
} from '@/services/transcription/RealtimeMeetingWsService';
import {
  deriveCloudMeetingStatus,
  isCaptureStalled,
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
  const [started, setStarted] = useState(false);
  const [failed, setFailed] = useState(false);
  const [capturing, setCapturing] = useState(true);
  const [stalled, setStalled] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [partialText, setPartialText] = useState('');
  const [utterances, setUtterances] = useState<RealtimeUtterance[]>([]);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [capturedSeconds, setCapturedSeconds] = useState(0);
  const [droppedSeconds, setDroppedSeconds] = useState(0);
  const [interruptions, setInterruptions] = useState(0);
  const [reconnects, setReconnects] = useState(0);

  const sessionRef = useRef<RealtimeSession | null>(null);
  const startedAtRef = useRef<number | null>(null);
  const stoppedRef = useRef(false);
  const utteranceCountRef = useRef(0);
  const onUtteranceRef = useRef(onUtterance);
  onUtteranceRef.current = onUtterance;
  const lastCapturedMsRef = useRef(0);
  const lastGrowthAtRef = useRef(0);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    setStarted(false);
    setFailed(false);
    setReconnecting(false);
    setCapturing(true);
    setStalled(false);
    startRealtimeMeetingWs(
      { language },
      {
        onPartial: (text) => setPartialText(text),
        onUtterance: (utterance) => {
          const index = utteranceCountRef.current;
          utteranceCountRef.current += 1;
          setUtterances((prev) => [...prev, utterance]);
          setPartialText('');
          onUtteranceRef.current?.(utterance, index, sessionRef.current?.capturedMs() ?? 0);
        },
        onError: (e) => {
          if (stoppedRef.current) return;
          const message = (e as { error?: { message?: string } })?.error?.message;
          setError(typeof message === 'string' ? message : 'Transcription error');
          setFailed(true);
        },
        onClose: () => {
          // A close we didn't initiate (server/network drop) is an error.
          if (!stoppedRef.current) setFailed(true);
        },
        onReconnecting: () => {
          // Safe to clear a transient failure here: a terminal one sets `terminated` in the
          // service, so no reconnect follows it.
          if (stoppedRef.current) return;
          setPartialText('');
          setFailed(false);
          setReconnecting(true);
          setReconnects((n) => n + 1);
        },
        onReconnected: () => {
          if (!stoppedRef.current) setReconnecting(false);
        },
        onCaptureState: ({ capturing: next }) => {
          if (!stoppedRef.current) setCapturing(next);
        },
      },
    )
      .then((session) => {
        if (cancelled) {
          void session.stop();
          return;
        }
        sessionRef.current = session;
        const now = Date.now();
        startedAtRef.current = now;
        lastGrowthAtRef.current = now;
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
      if (capturedMs > lastCapturedMsRef.current) {
        lastCapturedMsRef.current = capturedMs;
        lastGrowthAtRef.current = now;
      }
      setStalled(isCaptureStalled(lastGrowthAtRef.current, now));
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
  const micCapturingRef = useRef(micCapturing);
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

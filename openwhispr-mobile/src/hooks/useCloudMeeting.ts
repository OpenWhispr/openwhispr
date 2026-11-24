import { useCallback, useEffect, useRef, useState } from 'react';
import {
  startRealtimeMeetingWs,
  type RealtimeSession,
  type RealtimeUtterance,
} from '@/services/transcription/RealtimeMeetingWsService';
import type { AudioWindow } from '@/services/transcription/realtimeReconnect';
import { addRecordingFailedListener } from '../../modules/live-pcm-streaming/src';
import {
  deriveCloudMeetingStatus,
  initialCloudMeetingSession,
  trackCaptureGrowth,
  type CloudMeetingStatus,
} from '@/lib/notes/meetingCapture';
import { reportCaptureInterrupted, reportSessionEnded } from '@/lib/meetingCaptureTelemetry';

export type { CloudMeetingStatus } from '@/lib/notes/meetingCapture';

export interface CloudMeetingResult {
  utterances: RealtimeUtterance[];
  /** Windows of audio the live stream never received; the recording may still hold them. */
  droppedWindows: AudioWindow[];
  /** The recording to trust; null when it failed, was never requested, or no session ran. */
  recordingUri: string | null;
}

export interface CloudMeeting {
  status: CloudMeetingStatus;
  error: string | null;
  partialText: string;
  utterances: RealtimeUtterance[];
  /** Audio the mic actually delivered, in seconds. */
  capturedSeconds: number;
  /** Audio lost because no socket could take it during an outage, in seconds. */
  droppedSeconds: number;
  /** Times the mic stopped delivering audio. */
  interruptions: number;
  /** Times the socket dropped and had to reconnect. */
  reconnects: number;
  /**
   * Epoch ms at which the session started capturing; null until then. The mic prompt and
   * connect come before it, so a meeting's recorded share is measured from here.
   */
  liveSinceMs: number | null;
  /** Stops the session, waits for the last turn, and returns every finalized utterance. */
  stop: () => Promise<CloudMeetingResult>;
}

/**
 * Owns a cloud realtime transcription session for a meeting. Starts the WebSocket
 * + native-PCM session when `enabled` becomes true, streams partial/finalized
 * utterances into state, and tracks captured and dropped time. Lives in
 * `MeetingRecordScreen` (not the presentational recording component) so the screen's
 * finish handler can call `stop()` and read the final utterances and captured time to
 * persist them.
 */
export function useCloudMeeting({
  enabled,
  language,
  recordingUri,
  onUtterance,
}: {
  enabled: boolean;
  language?: string;
  /** Where the capture module also writes the meeting's audio; none means no recording. */
  recordingUri?: string;
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
  const [capturedSeconds, setCapturedSeconds] = useState(initial.capturedSeconds);
  const [droppedSeconds, setDroppedSeconds] = useState(initial.droppedSeconds);
  const [interruptions, setInterruptions] = useState(initial.interruptions);
  const [reconnects, setReconnects] = useState(initial.reconnects);
  const [liveSinceMs, setLiveSinceMs] = useState<number | null>(null);

  const sessionRef = useRef<RealtimeSession | null>(null);
  const stoppedRef = useRef(false);
  // Bumped per recording so a previous session still draining its last turn can't write
  // into the next one.
  const generationRef = useRef(0);
  const utteranceCountRef = useRef(initial.utteranceCount);
  const clockRef = useRef(initial.clock);
  const micCapturingRef = useRef(initial.capturing);
  // Native reason for the latest not-capturing event; null while the mic reports capturing.
  const captureLostReasonRef = useRef<string | null>(null);
  // Set when the recording file stopped during the current session; cleared per session.
  const recordingFailedRef = useRef(false);
  // Captured when the session starts: `stop` is memoized and the option may only arrive then.
  const recordingUriRef = useRef<string | undefined>(undefined);
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
    utteranceCountRef.current = fresh.utteranceCount;
    clockRef.current = fresh.clock;
    micCapturingRef.current = fresh.capturing;
    captureLostReasonRef.current = null;
    recordingFailedRef.current = false;
    recordingUriRef.current = recordingUri;
    // Attached before start: a file that can't be opened is reported before start resolves.
    // The generation check keeps an earlier session's late event off this one.
    const failedSubscription = addRecordingFailedListener(() => {
      if (generationRef.current === generation) recordingFailedRef.current = true;
    });
    let endReported = false;
    // Once per session: a close and a rejected start can both describe the same end.
    const reportEnded = (): void => {
      if (endReported) return;
      endReported = true;
      // The service gives no reason for a refused token apart from other failures.
      reportSessionEnded({
        path: 'cloud',
        reason: 'error',
        capturedSeconds: Math.floor((liveSession?.capturedMs() ?? 0) / 1000),
      });
    };
    setStarted(fresh.started);
    setFailed(fresh.failed);
    setCapturing(fresh.capturing);
    setStalled(fresh.stalled);
    setReconnecting(fresh.reconnecting);
    setError(fresh.error);
    setPartialText(fresh.partialText);
    setUtterances(fresh.utterances);
    setCapturedSeconds(fresh.capturedSeconds);
    setDroppedSeconds(fresh.droppedSeconds);
    setInterruptions(fresh.interruptions);
    setReconnects(fresh.reconnects);
    setLiveSinceMs(null);
    const isCurrent = (): boolean => generationRef.current === generation;
    const isLive = (): boolean => isCurrent() && !stoppedRef.current;
    startRealtimeMeetingWs(
      { language, recordingUri },
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
          if (!isLive()) return;
          setFailed(true);
          reportEnded();
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
        onCaptureState: ({ capturing: next, reason }) => {
          if (!isLive()) return;
          captureLostReasonRef.current = next ? null : reason || 'unknown';
          setCapturing(next);
        },
      },
    )
      .then((session) => {
        // Stop pressed while connecting already answered with no utterances; nothing would
        // stop this session later while the screen keeps the hook enabled.
        if (cancelled || stoppedRef.current) {
          void session.stop();
          return;
        }
        liveSession = session;
        sessionRef.current = session;
        const now = Date.now();
        setLiveSinceMs(now);
        // Startup can take seconds; the stall clock starts when capture does.
        clockRef.current = { ...clockRef.current, lastGrowthAtMs: now };
        setStarted(true);
      })
      .catch((e) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
        setFailed(true);
        reportEnded();
      });

    return () => {
      cancelled = true;
      stoppedRef.current = true;
      failedSubscription?.remove();
      void sessionRef.current?.stop();
      sessionRef.current = null;
    };
    // Start once when enabled; language is captured at start and never re-triggers.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]);

  useEffect(() => {
    // Keep ticking through reconnects and interruptions: the captured clock is how a
    // silent stall is noticed.
    if (!started || failed) return;
    const update = (): void => {
      const session = sessionRef.current;
      if (!session) return;
      const now = Date.now();
      const capturedMs = session.capturedMs();
      const growth = trackCaptureGrowth(clockRef.current, capturedMs, now);
      clockRef.current = growth.clock;
      setStalled(growth.stalled);
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
      reportCaptureInterrupted({
        path: 'cloud',
        // No native loss on record means the mic is reporting audio but none is arriving.
        reason: captureLostReasonRef.current ?? 'stalled',
        capturedSeconds: Math.floor((sessionRef.current?.capturedMs() ?? 0) / 1000),
      });
    }
    micCapturingRef.current = micCapturing;
  }, [started, micCapturing]);

  const stop = useCallback(async (): Promise<CloudMeetingResult> => {
    stoppedRef.current = true;
    const session = sessionRef.current;
    sessionRef.current = null;
    if (!session) return { utterances: [], droppedWindows: [], recordingUri: null };
    await session.stop();
    // Read after the stop settles: the stop itself can add dropped windows or fail the file.
    const uri = recordingUriRef.current;
    return {
      utterances: session.utterances(),
      droppedWindows: session.droppedWindows(),
      recordingUri: uri && !recordingFailedRef.current ? uri : null,
    };
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
    capturedSeconds,
    droppedSeconds,
    interruptions,
    reconnects,
    liveSinceMs,
    stop,
  };
}

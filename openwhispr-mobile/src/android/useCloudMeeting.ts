import { useCallback, useEffect, useRef, useState } from 'react';
import {
  startRealtimeMeetingWs,
  type RealtimeSession,
  type RealtimeUtterance,
} from './RealtimeMeetingWsService';
import { finishSpeakers, startSpeakers, type LiveSpeakerResult } from '@/android/liveSpeakers/live';

export type CloudMeetingStatus = 'connecting' | 'live' | 'reconnecting' | 'error';

export class CloudMeetingFinishError extends Error {
  constructor(
    error: unknown,
    readonly utterances: RealtimeUtterance[],
  ) {
    super(error instanceof Error ? error.message : String(error));
    this.name = 'CloudMeetingFinishError';
  }
}

export interface CloudMeeting {
  status: CloudMeetingStatus;
  error: string | null;
  partialText: string;
  utterances: RealtimeUtterance[];
  elapsedSeconds: number;
  /** Stops the session and returns the finalized utterances captured so far. */
  stop: () => Promise<RealtimeUtterance[]>;
  cancel: () => Promise<void>;
  stopRequested: boolean;
  /** Speaker label per utterance id, a beat behind the text. */
  speakerLabels?: Record<string, string>;
  /** What speaker labelling knew when the meeting stopped (after `stop` settles). */
  speakerResult?: () => LiveSpeakerResult | null;
}

/**
 * Owns a cloud realtime transcription session for a meeting. Starts the WebSocket
 * + native-PCM session when `enabled` becomes true, streams partial/finalized
 * utterances into state, and tracks elapsed time. Lives in `MeetingRecordScreen`
 * (not the presentational recording component) so the screen's finish handler can
 * call `stop()` and read the final utterances/elapsed to persist them.
 */
export function useCloudMeeting({
  enabled,
  language,
  noteId,
}: {
  enabled: boolean;
  language?: string;
  noteId?: number;
}): CloudMeeting {
  const [stopRequested, setStopRequested] = useState(false);
  const [status, setStatus] = useState<CloudMeetingStatus>('connecting');
  const [error, setError] = useState<string | null>(null);
  const [partialText, setPartialText] = useState('');
  const [utterances, setUtterances] = useState<RealtimeUtterance[]>([]);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [speakerLabels, setSpeakerLabels] = useState<Record<string, string>>({});
  const liveRef = useRef<ReturnType<typeof startSpeakers>>(null);
  const speakerResultRef = useRef<LiveSpeakerResult | null>(null);

  const controllerRef = useRef<AbortController | null>(null);
  const finishRef = useRef<Promise<RealtimeUtterance[]> | null>(null);
  const sessionRef = useRef<RealtimeSession | null>(null);
  const startupRef = useRef<Promise<RealtimeSession> | null>(null);
  const startedAtRef = useRef<number | null>(null);
  const stoppedRef = useRef(false);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    stoppedRef.current = false;
    finishRef.current = null;
    startedAtRef.current = null;
    const controller = new AbortController();
    controllerRef.current = controller;
    setStopRequested(false);
    setUtterances([]);
    setSpeakerLabels({});
    speakerResultRef.current = null;
    setPartialText('');
    setError(null);
    setElapsedSeconds(0);
    setStatus('connecting');
    // A key saved for meetings connects each leg itself; otherwise OpenWhispr Cloud does.
    let deps: ReturnType<typeof import('./providers/liveMeeting').liveMeetingDeps>;
    try {
      // Loaded here so the hook's importers don't pull in the settings store.
      const { liveMeetingDeps } =
        require('./providers/liveMeeting') as typeof import('./providers/liveMeeting');
      deps = liveMeetingDeps(language);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStatus('error');
      return;
    }
    // Before the transport, so speaker labelling counts the meeting's first audio frame.
    const live = startSpeakers(noteId, (labels) => {
      if (!cancelled && !controller.signal.aborted) setSpeakerLabels(labels);
    });
    liveRef.current = live;
    const startup = startRealtimeMeetingWs(
      { language, noteId, signal: controller.signal },
      {
        onStopRequested: () => {
          if (!cancelled && !controller.signal.aborted) setStopRequested(true);
        },
        onPartial: (text) => {
          if (!cancelled && !controller.signal.aborted) setPartialText(text);
        },
        onUtterances: (captured) => {
          if (cancelled || controller.signal.aborted) return;
          setUtterances(captured);
          setPartialText('');
        },
        onError: (e) => {
          if (cancelled || controller.signal.aborted || stoppedRef.current) return;
          const message = (e as { error?: { message?: string } })?.error?.message;
          setError(typeof message === 'string' ? message : 'Transcription error');
          setStatus('error');
        },
        onClose: () => {
          // A close we didn't initiate (server/network drop) is an error.
          if (!cancelled && !controller.signal.aborted && !stoppedRef.current) setStatus('error');
        },
        onReconnecting: () => {
          // Safe to clear a transient 'error' here: a terminal failure sets `terminated`
          // in the service, so no reconnect fires to override it.
          if (!cancelled && !controller.signal.aborted && !stoppedRef.current) {
            setPartialText('');
            setStatus('reconnecting');
          }
        },
        onReconnected: () => {
          if (!cancelled && !controller.signal.aborted && !stoppedRef.current) setStatus('live');
        },
      },
      live ? live.wrap(deps) : deps,
    );
    startupRef.current = startup;
    startup
      .then((session) => {
        if (cancelled || controller.signal.aborted || stoppedRef.current) {
          return session.stop();
        }
        sessionRef.current = session;
        startedAtRef.current = Date.now();
        setStatus('live');
      })
      .catch((e) => {
        if (cancelled || controller.signal.aborted || stoppedRef.current) return;
        setError(e instanceof Error ? e.message : String(e));
        setStatus('error');
      });

    return () => {
      cancelled = true;
      stoppedRef.current = true;
      // Stop and save opens the note at once (Figma R2b); a finish already running ends the
      // session itself, so leaving the screen must not cut off its last words.
      if (finishRef.current) return;
      liveRef.current?.stop();
      controller.abort();
      void sessionRef.current?.stop();
      sessionRef.current = null;
    };
    // Start once when enabled; language is captured at start and never re-triggers.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]);

  useEffect(() => {
    // Keep the wall clock ticking through a reconnect — it feeds the segment-timing fallback.
    if (status !== 'live' && status !== 'reconnecting') return;
    const update = () => {
      const startedAt = startedAtRef.current;
      if (startedAt == null) return;
      setElapsedSeconds(Math.floor((Date.now() - startedAt) / 1000));
    };
    update();
    const interval = setInterval(update, 1000);
    return () => clearInterval(interval);
  }, [status]);

  const stop = useCallback((): Promise<RealtimeUtterance[]> => {
    if (finishRef.current) return finishRef.current;
    stoppedRef.current = true;
    finishRef.current = (async () => {
      const session = sessionRef.current;
      if (!session) {
        liveRef.current?.stop();
        controllerRef.current?.abort();
        await startupRef.current?.then(
          (started) => started.stop(),
          () => undefined,
        );
        throw new Error('Meeting stopped before recording was ready.');
      }
      try {
        if (session.finish) await session.finish();
        else await session.stop();
        return session.utterances();
      } catch (cause) {
        throw new CloudMeetingFinishError(cause, session.utterances());
      } finally {
        if (sessionRef.current === session) sessionRef.current = null;
        speakerResultRef.current = await finishSpeakers(liveRef.current).catch(() => null);
      }
    })();
    return finishRef.current;
  }, []);

  const cancel = useCallback(async (): Promise<void> => {
    stoppedRef.current = true;
    liveRef.current?.stop();
    controllerRef.current?.abort();
    const session = sessionRef.current;
    sessionRef.current = null;
    if (session) await session.stop();
    else
      await startupRef.current?.then(
        (started) => started.stop(),
        () => undefined,
      );
  }, []);
  const speakerResult = useCallback(() => speakerResultRef.current, []);
  return {
    status,
    error,
    partialText,
    utterances,
    elapsedSeconds,
    stop,
    cancel,
    stopRequested,
    speakerLabels,
    speakerResult,
  };
}

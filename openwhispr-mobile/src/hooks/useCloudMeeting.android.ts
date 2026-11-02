import { useCallback, useEffect, useRef, useState } from 'react';
import {
  startRealtimeMeetingWs,
  type RealtimeSession,
  type RealtimeUtterance,
} from '@/services/transcription/RealtimeMeetingWsService';

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
  cancel: () => void;
  stopRequested: boolean;
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

  const controllerRef = useRef<AbortController | null>(null);
  const finishRef = useRef<Promise<RealtimeUtterance[]> | null>(null);
  const sessionRef = useRef<RealtimeSession | null>(null);
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
    setPartialText('');
    setError(null);
    setElapsedSeconds(0);
    setStatus('connecting');
    startRealtimeMeetingWs(
      { language, noteId, signal: controller.signal },
      {
        onStopRequested: () => {
          if (!cancelled) setStopRequested(true);
        },
        onPartial: (text) => {
          if (!cancelled) setPartialText(text);
        },
        onUtterances: (captured) => {
          if (cancelled) return;
          setUtterances(captured);
          setPartialText('');
        },
        onError: (e) => {
          if (stoppedRef.current) return;
          const message = (e as { error?: { message?: string } })?.error?.message;
          setError(typeof message === 'string' ? message : 'Transcription error');
          setStatus('error');
        },
        onClose: () => {
          // A close we didn't initiate (server/network drop) is an error.
          if (!stoppedRef.current) setStatus('error');
        },
        onReconnecting: () => {
          // Safe to clear a transient 'error' here: a terminal failure sets `terminated`
          // in the service, so no reconnect fires to override it.
          if (!stoppedRef.current) {
            setPartialText('');
            setStatus('reconnecting');
          }
        },
        onReconnected: () => {
          if (!stoppedRef.current) setStatus('live');
        },
      },
    )
      .then((session) => {
        if (cancelled || stoppedRef.current) {
          session.stop();
          return;
        }
        sessionRef.current = session;
        startedAtRef.current = Date.now();
        setStatus('live');
      })
      .catch((e) => {
        if (cancelled || stoppedRef.current) return;
        setError(e instanceof Error ? e.message : String(e));
        setStatus('error');
      });

    return () => {
      cancelled = true;
      stoppedRef.current = true;
      controller.abort();
      sessionRef.current?.stop();
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
        controllerRef.current?.abort();
        throw new Error('Meeting stopped before recording was ready.');
      }
      try {
        if (session.finish) await session.finish();
        else session.stop();
        return session.utterances();
      } catch (cause) {
        throw new CloudMeetingFinishError(cause, session.utterances());
      } finally {
        sessionRef.current = null;
      }
    })();
    return finishRef.current;
  }, []);

  const cancel = useCallback(() => {
    stoppedRef.current = true;
    controllerRef.current?.abort();
    sessionRef.current?.stop();
    sessionRef.current = null;
  }, []);
  return { status, error, partialText, utterances, elapsedSeconds, stop, cancel, stopRequested };
}

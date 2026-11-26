import type { WebSocketLike } from '@/android/transcription/createRealtimeMeetingWs';

/**
 * How long OpenAI waits in silence before it ends a line, on meetings (its session starts at
 * 800 ms). People in a conversation usually answer within half a second, so at 800 ms one line
 * held both voices, or a whole meeting (A73, a two-voice podcast with 0.6 s gaps: one 5-minute
 * line), which leaves nothing to tell speakers apart by.
 */
export const MEETING_PAUSE_MS = 500;

/** Marks our update, so an error OpenAI sends back for it isn't taken for a meeting failure. */
export const QUICK_TURNS_EVENT_ID = 'ow_quick_turns';

type Factory = (url: string, protocols: string[]) => WebSocketLike;

type TurnDetection = {
  type?: string;
  threshold?: number;
  prefix_padding_ms?: number;
  silence_duration_ms?: number;
};

const defaultFactory: Factory = (url, protocols) =>
  new WebSocket(url, protocols) as unknown as WebSocketLike;

/** The session's own turn detection with the shorter pause, or nothing to change. */
export function quickerTurns(current: TurnDetection | null | undefined): TurnDetection | null {
  if (!current || current.type !== 'server_vad') return null;
  if ((current.silence_duration_ms ?? Infinity) <= MEETING_PAUSE_MS) return null;
  return {
    type: 'server_vad',
    ...(current.threshold !== undefined ? { threshold: current.threshold } : {}),
    ...(current.prefix_padding_ms !== undefined
      ? { prefix_padding_ms: current.prefix_padding_ms }
      : {}),
    silence_duration_ms: MEETING_PAUSE_MS,
  };
}

/**
 * Shortens OpenAI's end-of-line pause on each leg once its session exists, keeping every other
 * turn setting the session was created with (OpenWhispr's server or the phone's own key chose
 * them). A session with no server turn detection (a model that ends turns on commit) is left as
 * it is. Deepgram and AssemblyAI sockets never send these events, so they pass through untouched.
 */
export function quickTurns(factory: Factory = defaultFactory): Factory {
  return (url, protocols) => {
    const inner = factory(url, protocols);
    let sent = false;
    const socket: WebSocketLike = {
      get readyState() {
        return inner.readyState;
      },
      send: (data) => inner.send(data),
      close: (code, reason) => inner.close(code, reason),
      onopen: null,
      onmessage: null,
      onerror: null,
      onclose: null,
    };
    inner.onopen = (event) => socket.onopen?.(event);
    inner.onerror = (event) => socket.onerror?.(event);
    inner.onclose = (event) => socket.onclose?.(event);
    inner.onmessage = (event) => {
      let message: {
        type?: string;
        session?: {
          turn_detection?: TurnDetection;
          audio?: { input?: { turn_detection?: TurnDetection } };
        };
        error?: { event_id?: string };
      } | null = null;
      try {
        message = typeof event.data === 'string' ? JSON.parse(event.data) : null;
      } catch {
        message = null;
      }
      // OpenAI refused the shorter pause: the meeting goes on with the old one.
      if (message?.type === 'error' && message.error?.event_id === QUICK_TURNS_EVENT_ID) {
        console.info('[live-speakers] shorter pause refused; keeping the session’s own');
        return;
      }
      socket.onmessage?.(event);
      if (sent || !message) return;
      const created = message.type === 'session.created';
      const legacy = message.type === 'transcription_session.created';
      if (!created && !legacy) return;
      const turns = quickerTurns(
        created ? message.session?.audio?.input?.turn_detection : message.session?.turn_detection,
      );
      if (!turns) return;
      sent = true;
      try {
        inner.send(
          JSON.stringify(
            created
              ? {
                  type: 'session.update',
                  event_id: QUICK_TURNS_EVENT_ID,
                  session: { type: 'transcription', audio: { input: { turn_detection: turns } } },
                }
              : {
                  type: 'transcription_session.update',
                  event_id: QUICK_TURNS_EVENT_ID,
                  session: { turn_detection: turns },
                },
          ),
        );
      } catch {
        // The leg keeps its session's own pause.
      }
    };
    return socket;
  };
}

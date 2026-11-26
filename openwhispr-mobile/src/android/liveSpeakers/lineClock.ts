import type { WebSocketLike } from '@/android/transcription/createRealtimeMeetingWs';

/** Where one finished line sits in the meeting WAV, and the provider's speaker if it sent one. */
export interface LineSpan {
  /** The transport's utterance id (`L<leg>:<item>`). */
  itemId: string;
  startMs: number;
  endMs: number;
  /** True when the provider sent no timings and the span was worked out from the audio sent. */
  estimated: boolean;
  /** The provider's own speaker for the line ("A", "0"…), when it labels speakers itself. */
  providerSpeaker: string | null;
}

type Factory = (url: string, protocols: string[]) => WebSocketLike;

const defaultFactory: Factory = (url, protocols) =>
  new WebSocket(url, protocols) as unknown as WebSocketLike;

// OpenAI's server VAD closes a turn after 800 ms of silence; a line with no timings ends about then.
const VAD_TAIL_MS = 800;
const MS_PER_CHARACTER = 65;
const MIN_ESTIMATE_MS = 1000;
const MAX_ESTIMATE_MS = 15000;

function base64Bytes(base64: string): number {
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
  return Math.floor((base64.length * 3) / 4) - padding;
}

/**
 * Keeps every line of a live meeting on the WAV's own clock. Each leg (one socket, restarted on
 * reconnect or rotation) counts its audio from zero; the transport sends a leg everything it has
 * buffered at each flush, so the leg's first byte sits at (audio captured − audio sent to the leg)
 * when it sends. That holds across reconnects, replays and dropped buffers, which wall-clock leg
 * offsets do not. Wraps the sockets only: the transport itself is unchanged.
 */
export function createLineClock(options: { sampleRate: number; onLine: (line: LineSpan) => void }) {
  const bytesPerMs = (options.sampleRate * 2) / 1000;
  let captured = 0;
  let legs = 0;
  let lastEndMs = 0;

  const wrap = (inner: WebSocketLike, leg: number): WebSocketLike => {
    let sent = 0;
    let startBytes: number | null = null;
    const times = new Map<string, { startMs?: number; endMs?: number }>();
    const legMs = (ms: number) => (startBytes ?? 0) / bytesPerMs + ms;

    const read = (data: string) => {
      let event: {
        type?: string;
        item_id?: string;
        audio_start_ms?: number;
        audio_end_ms?: number;
        transcript?: string;
        speaker?: string | number | null;
      };
      try {
        event = JSON.parse(data);
      } catch {
        return;
      }
      const id = event.item_id;
      if (!id) return;
      if (
        event.type === 'input_audio_buffer.speech_started' &&
        typeof event.audio_start_ms === 'number'
      )
        times.set(id, { ...times.get(id), startMs: event.audio_start_ms });
      else if (
        event.type === 'input_audio_buffer.speech_stopped' &&
        typeof event.audio_end_ms === 'number'
      )
        times.set(id, { ...times.get(id), endMs: event.audio_end_ms });
      else if (event.type === 'conversation.item.input_audio_transcription.completed') {
        const text = (event.transcript ?? '').trim();
        const known = times.get(id);
        times.delete(id);
        if (!text || startBytes === null) return;
        let startMs: number;
        let endMs: number;
        const estimated = known?.startMs === undefined || known?.endMs === undefined;
        if (!estimated) {
          startMs = legMs(known!.startMs!);
          endMs = legMs(known!.endMs!);
        } else {
          const length = Math.min(
            MAX_ESTIMATE_MS,
            Math.max(MIN_ESTIMATE_MS, text.length * MS_PER_CHARACTER),
          );
          endMs =
            known?.endMs !== undefined
              ? legMs(known.endMs)
              : Math.max(lastEndMs, legMs(sent / bytesPerMs) - VAD_TAIL_MS);
          startMs =
            known?.startMs !== undefined
              ? legMs(known.startMs)
              : Math.max(lastEndMs, endMs - length);
        }
        if (endMs <= startMs) return;
        lastEndMs = Math.max(lastEndMs, endMs);
        const speaker = event.speaker;
        options.onLine({
          itemId: `L${leg}:${id}`,
          startMs: Math.round(startMs),
          endMs: Math.round(endMs),
          estimated,
          providerSpeaker:
            speaker === null || speaker === undefined || speaker === '' ? null : String(speaker),
        });
      }
    };

    const socket: WebSocketLike = {
      get readyState() {
        return inner.readyState;
      },
      send(data: string) {
        if (inner.readyState === 1 && data.includes('"input_audio_buffer.append"')) {
          try {
            const audio = (JSON.parse(data) as { audio?: string }).audio;
            if (audio) {
              sent += base64Bytes(audio);
              startBytes ??= Math.max(0, captured - sent);
            }
          } catch {
            // Not ours to judge; the transport sends it as it is.
          }
        }
        inner.send(data);
      },
      close: (code, reason) => inner.close(code, reason),
      onopen: null,
      onmessage: null,
      onerror: null,
      onclose: null,
    };
    inner.onopen = (event) => socket.onopen?.(event);
    inner.onmessage = (event) => {
      if (typeof event.data === 'string') read(event.data);
      socket.onmessage?.(event);
    };
    inner.onerror = (event) => socket.onerror?.(event);
    inner.onclose = (event) => socket.onclose?.(event);
    return socket;
  };

  return {
    /** Every captured PCM frame, in order, before the transport sends it. */
    captured(bytes: number) {
      captured += bytes;
    },
    /** The transport calls the factory once per leg, in leg order, so legs number as it does. */
    wrapFactory(factory: Factory = defaultFactory): Factory {
      return (url, protocols) => wrap(factory(url, protocols), ++legs);
    },
  };
}

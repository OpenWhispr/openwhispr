import type { WebSocketLike } from '@/services/transcription/createRealtimeMeetingWs';

export interface LiveEmit {
  /** The caption so far for the turn in progress (replaces the last one). */
  partial(text: string): void;
  /**
   * A finished turn, with its start and end in ms from the leg's first audio, and the provider's
   * speaker for it when the provider labels speakers.
   */
  final(text: string, startMs: number | null, endMs: number | null, speaker?: string | null): void;
  error(message: string): void;
}

export interface LiveAdapterOptions {
  url: string;
  protocols?: string[];
  /** Sent while the socket is open, so a quiet meeting isn't closed for inactivity. */
  keepAlive?: { everyMs: number; message: string };
  /** Sent for the transport's commit: finish the turn in progress now. */
  commit?: string;
  /** Sent before closing, so the provider ends the stream cleanly. */
  close?: string;
  translate(message: unknown, emit: LiveEmit): void;
}

type InnerSocket = {
  readyState: number;
  send(data: string | ArrayBuffer): void;
  close(code?: number, reason?: string): void;
  onopen: ((event?: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: ((event?: unknown) => void) | null;
  onclose: ((event: { code?: number }) => void) | null;
};

const OPEN = 1;

function base64Bytes(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes.buffer;
}

/**
 * Wraps a provider's live transcription socket (Deepgram, AssemblyAI) as the OpenAI Realtime
 * socket the meeting transport drives: audio appends become binary PCM frames, a commit becomes
 * the provider's "finish this turn", and the provider's results come back as Realtime events.
 * The transport's leg swaps, reconnects and capture all work unchanged.
 */
export function liveAdapter(
  options: LiveAdapterOptions,
  createSocket: (url: string, protocols?: string[]) => InnerSocket = (url, protocols) =>
    new WebSocket(url, protocols) as unknown as InnerSocket,
): WebSocketLike {
  const inner = createSocket(options.url, options.protocols);
  let keepAlive: ReturnType<typeof setInterval> | null = null;
  let turn = 0;
  let partialId: string | null = null;

  const adapter: WebSocketLike = {
    get readyState() {
      return inner.readyState;
    },
    send(data: string) {
      if (inner.readyState !== OPEN) return;
      const event = JSON.parse(data) as { type?: string; audio?: string };
      if (event.type === 'input_audio_buffer.append' && event.audio)
        inner.send(base64Bytes(event.audio));
      else if (event.type === 'input_audio_buffer.commit' && options.commit)
        inner.send(options.commit);
    },
    close(code?: number, reason?: string) {
      if (keepAlive) clearInterval(keepAlive);
      keepAlive = null;
      if (inner.readyState === OPEN && options.close) inner.send(options.close);
      inner.close(code, reason);
    },
    onopen: null,
    onmessage: null,
    onerror: null,
    onclose: null,
  };

  const deliver = (event: object) => adapter.onmessage?.({ data: JSON.stringify(event) });
  // Each caption gets its own item, so the newest replaces the last; the old one is cleared.
  const clearPartial = () => {
    if (!partialId) return;
    deliver({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: partialId,
      transcript: '',
    });
    partialId = null;
  };
  const emit: LiveEmit = {
    partial(text) {
      clearPartial();
      if (!text.trim()) return;
      partialId = `partial_${++turn}`;
      deliver({
        type: 'conversation.item.input_audio_transcription.delta',
        item_id: partialId,
        delta: text,
      });
    },
    final(text, startMs, endMs, speaker) {
      clearPartial();
      if (!text.trim()) return;
      const itemId = `turn_${++turn}`;
      if (startMs !== null)
        deliver({
          type: 'input_audio_buffer.speech_started',
          item_id: itemId,
          audio_start_ms: startMs,
        });
      if (endMs !== null)
        deliver({
          type: 'input_audio_buffer.speech_stopped',
          item_id: itemId,
          audio_end_ms: endMs,
        });
      deliver({
        type: 'conversation.item.input_audio_transcription.completed',
        item_id: itemId,
        transcript: text,
        ...(speaker != null ? { speaker } : {}),
      });
    },
    error(message) {
      deliver({ type: 'error', error: { message } });
    },
  };

  inner.onopen = (event) => {
    if (options.keepAlive) {
      const { everyMs, message } = options.keepAlive;
      keepAlive = setInterval(() => {
        if (inner.readyState === OPEN) inner.send(message);
      }, everyMs);
    }
    adapter.onopen?.(event);
  };
  inner.onmessage = (event) => {
    if (typeof event.data !== 'string') return;
    let message: unknown;
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }
    options.translate(message, emit);
  };
  inner.onerror = (event) => adapter.onerror?.(event);
  inner.onclose = (event) => {
    if (keepAlive) clearInterval(keepAlive);
    keepAlive = null;
    adapter.onclose?.(event);
  };
  return adapter;
}

/**
 * GPT-4o Realtime meeting transcription over a WebSocket with raw native PCM.
 *
 * A session spans one or more legs (one OpenAI ws + ephemeral token each). The mic,
 * event reducer, PCM ring buffer, and flush timer are session-scoped and outlive any
 * leg; only the active socket (transport.currentWs) is swapped — on reconnect (network drop) or
 * rotation (before OpenAI's ~60-min session cap). One reducer means utterances
 * accumulate across every leg; each leg's messages are rewritten first (item_id
 * namespaced, timings offset) so a fresh leg's restarted ids/clock don't collide with
 * or rewind the transcript.
 *
 * Auth rides in the WS subprotocol, not a header — RN mangles custom WS headers on iOS.
 */
import { Buffer } from 'buffer';
import * as Network from 'expo-network';
import { api } from '@/lib/apiClient';
import { withRetry, createApiRetryStrategy } from '@/lib/retry';
import {
  LivePCMStreaming,
  addPcmFrameListener,
  DEFAULT_SAMPLE_RATE,
  type PcmFrame,
} from '../../../modules/live-pcm-streaming/src';
import { transcriptionPolicyErrorFromApiError } from './policyErrors';
import { createRealtimeEventReducer } from './realtimeEvents';
import type {
  RealtimeCallbacks,
  RealtimeSession,
  RealtimeUtterance,
  RealtimeEventReducer,
} from './realtimeEvents';
import {
  PcmRingBuffer,
  applyLegOffset,
  classifyClose,
  namespaceItemId,
  pcmTailCapBytes,
  ROTATION_MS,
  RECONNECT_MAX_RETRIES,
  RECONNECT_INITIAL_DELAY_MS,
  RECONNECT_MAX_DELAY_MS,
  CONNECT_TIMEOUT_MS,
} from './realtimeReconnect';

export type { RealtimeCallbacks, RealtimeSession, RealtimeUtterance } from './realtimeEvents';

const OPENAI_REALTIME_WS_URL = 'wss://api.openai.com/v1/realtime?intent=transcription';
// bufferedAmount is undefined on RN, so batching sends at this cadence is the only
// backpressure control available.
const FLUSH_INTERVAL_MS = 150;
const WS_OPEN = 1; // WebSocket.OPEN, decoupled from the global so tests can inject a fake

interface TokenResponse {
  clientSecret: string;
  model: string;
}

/** Minimal WebSocket surface the leg-swap plumbing depends on (injectable for tests). */
export interface WebSocketLike {
  readyState: number;
  send: (data: string) => void;
  close: (code?: number, reason?: string) => void;
  onopen: ((event?: unknown) => void) | null;
  onmessage: ((event: { data: string }) => void) | null;
  onerror: ((event?: unknown) => void) | null;
  onclose: ((event: { code?: number }) => void) | null;
}

export interface RealtimeMeetingDeps {
  wsFactory?: (url: string, protocols: string[]) => WebSocketLike;
}

export interface RealtimeTransportOptions {
  language?: string;
  model?: string;
  sampleRate?: number;
  noteId?: number;
  signal?: AbortSignal;
}
export interface RealtimeTransportCallbacks extends RealtimeCallbacks {
  onStopRequested?: () => void;
  onUtterances?: (utterances: RealtimeUtterance[]) => void;
}
export interface RealtimeTransportSession extends RealtimeSession {
  finish?: () => Promise<void>;
}
export interface RealtimeTransportState {
  currentWs: WebSocketLike | null;
  frameSub: { remove(): void } | null;
  flushTimer: ReturnType<typeof setInterval> | null;
  rotationTimer: ReturnType<typeof setTimeout> | null;
  terminated: boolean;
}
export interface RealtimeTransportContext {
  opts: RealtimeTransportOptions;
  callbacks: RealtimeTransportCallbacks;
  sampleRate: number;
  transport: RealtimeTransportState;
  capture: {
    start(sampleRate: number, noteId?: number, signal?: AbortSignal): Promise<void>;
    stop(): Promise<void>;
  };
  reducer: RealtimeEventReducer;
  flush(): void;
  closeWs(ws: WebSocketLike | null, options?: { commit?: boolean }): void;
  teardownCapture(): void;
  goTerminal(error: unknown): void;
}
export interface RealtimeTransportLifecycle {
  readonly finishing: boolean;
  audioIncomplete(): void;
  markClosed(ws: WebSocketLike): void;
  beforeFrameCleanup(): void;
  afterFrameCleanup(): void;
  handleMessage(ws: WebSocketLike, event: { data: string }): void;
  registerLeg(ws: WebSocketLike, meta: { legIndex: number; offsetMs: number }): void;
  retireLeg(ws: WebSocketLike): void;
  terminal(error: unknown): void;
  legClosed(ws: WebSocketLike): boolean;
  stop(): void;
  beforeToken(): void;
  afterToken(): void;
  startCapture(): Promise<void>;
  sessionMethods(): Omit<RealtimeTransportSession, 'stop'>;
}

const defaultWsFactory = (url: string, protocols: string[]): WebSocketLike =>
  new WebSocket(url, protocols) as unknown as WebSocketLike;

export function createRealtimeMeetingWs(
  createLifecycle?: (context: RealtimeTransportContext) => RealtimeTransportLifecycle,
) {
  return async function startRealtimeMeetingWs(
    opts: RealtimeTransportOptions = {},
    callbacks: RealtimeTransportCallbacks = {},
    deps: RealtimeMeetingDeps = {},
  ): Promise<RealtimeTransportSession> {
    const sampleRate = opts.sampleRate ?? DEFAULT_SAMPLE_RATE;
    const wsFactory = deps.wsFactory ?? defaultWsFactory;

    const tokenBody = (): Record<string, unknown> => ({
      purpose: 'meeting',
      streams: 1,
      ...(opts.model ? { model: opts.model } : {}),
      ...(opts.language ? { language: opts.language } : {}),
    });

    const fetchClientSecret = async (): Promise<string> => {
      try {
        const { clientSecret } = await api.post<TokenResponse>(
          '/api/openai-realtime-token',
          tokenBody(),
        );
        return clientSecret;
      } catch (error) {
        // Org refusals show the same copy as /api/transcribe, not the raw server text.
        throw transcriptionPolicyErrorFromApiError(error) ?? error;
      }
    };

    // One reducer per session — this is why utterances survive every leg swap.
    const reducer = createRealtimeEventReducer(callbacks);
    const pcmRing = new PcmRingBuffer(pcmTailCapBytes(sampleRate));
    // Per-leg index + offset, keyed by socket so a replaced leg's late messages keep
    // their own leg's namespace/offset during a swap.
    const legMeta = new WeakMap<WebSocketLike, { legIndex: number; offsetMs: number }>();

    // Leg mid-connect; tracked so a terminal stop closes it instead of leaking until timeout.
    const transport: RealtimeTransportState = {
      currentWs: null,
      frameSub: null,
      flushTimer: null,
      rotationTimer: null,
      terminated: false,
    };
    let lifecycle: RealtimeTransportLifecycle | undefined;
    let connectingWs: WebSocketLike | null = null;

    let legIndex = 0;
    let cumulativeOffsetMs = 0; // summed wall-clock duration of all prior legs
    let legStartedAt = 0;
    let sessionStartedAt = 0; // drives the rotate-vs-reconnect age

    // transport.terminated makes stop()/goTerminal idempotent and cancels in-flight swaps;
    // rotating/reconnecting serialize swaps.
    let rotating = false;
    let reconnecting = false;
    let closeNotified = false;

    const notifyClose = (): void => {
      if (closeNotified) return;
      closeNotified = true;
      callbacks.onClose?.();
    };

    const enqueuePcm = (buf: Buffer): void => {
      const expectedBytes = pcmRing.byteLength + buf.length;
      pcmRing.push(buf);
      if (pcmRing.byteLength < expectedBytes) lifecycle?.audioIncomplete();
    };

    const flush = (): void => {
      const ws = transport.currentWs;
      if (!ws || ws.readyState !== WS_OPEN) return; // during an outage this no-ops; PCM keeps buffering
      const chunks = pcmRing.drain();
      if (chunks.length === 0) return;
      // Merge by bytes; base64 concatenation is only valid on 3-byte-aligned chunks.
      const merged = Buffer.concat(chunks);
      try {
        ws.send(
          JSON.stringify({ type: 'input_audio_buffer.append', audio: merged.toString('base64') }),
        );
      } catch {
        lifecycle?.audioIncomplete();
      }
    };

    const closeWs = (ws: WebSocketLike | null, options?: { commit?: boolean }): void => {
      if (!ws) return;
      lifecycle?.markClosed(ws);
      try {
        // Optional final commit so the leg's last turn finalizes (empty buffer → benign commit_empty).
        if (options?.commit && ws.readyState === WS_OPEN) {
          ws.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
        }
        ws.close();
      } catch {
        // best-effort teardown
      }
    };

    // Mic + timers only, never the socket — a reconnectable close must not stop capture.
    const teardownCapture = (): void => {
      lifecycle?.beforeFrameCleanup();
      transport.frameSub?.remove();
      transport.frameSub = null;
      lifecycle?.afterFrameCleanup();
      LivePCMStreaming.stop().catch(() => {});
      if (transport.flushTimer) {
        clearInterval(transport.flushTimer);
        transport.flushTimer = null;
      }
      if (transport.rotationTimer) {
        clearTimeout(transport.rotationTimer);
        transport.rotationTimer = null;
      }
      // Close any in-flight connect so a stop doesn't leave it to time out (and re-enter retry).
      if (connectingWs) {
        closeWs(connectingWs);
        connectingWs = null;
      }
    };

    const handleMessage = (ws: WebSocketLike, event: { data: string }): void => {
      if (lifecycle) return lifecycle.handleMessage(ws, event);
      let parsed: unknown;
      try {
        parsed = JSON.parse(event.data);
      } catch {
        return;
      }
      const evt = parsed as { type?: string; error?: { code?: string } };
      if (evt.type === 'error' && evt.error?.code === 'input_audio_buffer_commit_empty') {
        return; // benign: our commit hit an already-drained buffer
      }
      const meta = legMeta.get(ws) ?? { legIndex: 0, offsetMs: 0 };
      const rewritten = applyLegOffset(parsed as object, meta.offsetMs) as { item_id?: unknown };
      if (typeof rewritten.item_id === 'string') {
        rewritten.item_id = namespaceItemId(meta.legIndex, rewritten.item_id);
      }
      reducer.handleEvent(rewritten);
    };

    // Opens one leg; resolves on open, rejects on pre-open close/error/timeout. Does NOT
    // tear down capture on close — a post-open close routes to handleLegClosed.
    const connectLeg = (
      clientSecret: string,
      meta: { legIndex: number; offsetMs: number },
    ): Promise<WebSocketLike> =>
      new Promise<WebSocketLike>((resolve, reject) => {
        const ws = wsFactory(OPENAI_REALTIME_WS_URL, [
          'realtime',
          `openai-insecure-api-key.${clientSecret}`,
        ]);
        legMeta.set(ws, meta);
        lifecycle?.registerLeg(ws, meta);
        connectingWs = ws;
        let settled = false;
        let timer: ReturnType<typeof setTimeout>;
        const settle = (): void => {
          settled = true;
          clearTimeout(timer);
          if (connectingWs === ws) connectingWs = null;
        };
        timer = setTimeout(() => {
          if (settled) return;
          settle();
          try {
            ws.close();
          } catch {
            // ignore
          }
          reject(new Error('Realtime WebSocket connect timeout'));
        }, CONNECT_TIMEOUT_MS);

        ws.onopen = () => {
          if (settled) return;
          settle();
          resolve(ws);
        };
        ws.onmessage = (e) => handleMessage(ws, e);
        ws.onerror = () => {
          // A post-open error is always followed by onclose (which drives the reconnect/
          // terminal decision), so we don't surface it here as onError.
          if (settled) return;
          settle();
          try {
            ws.close();
          } catch {
            // ignore
          }
          reject(new Error('Realtime WebSocket connection error'));
        };
        ws.onclose = (e) => {
          const code = (e as { code?: number } | undefined)?.code;
          if (!settled) {
            settle();
            reject(new Error(`Realtime WebSocket closed before open (code ${code ?? 'unknown'})`));
            return;
          }
          void handleLegClosed(ws, code);
        };
      });

    const openLeg = (clientSecret: string): Promise<WebSocketLike> => {
      legIndex += 1;
      return connectLeg(clientSecret, { legIndex, offsetMs: cumulativeOffsetMs });
    };

    const scheduleRotation = (): void => {
      if (transport.rotationTimer) clearTimeout(transport.rotationTimer);
      transport.rotationTimer = setTimeout(() => {
        void rollLeg();
      }, ROTATION_MS);
    };

    // The default transport commits and closes the retiring leg immediately. A
    // recovery lifecycle may drain it while new audio goes to its replacement.
    const swapCurrentLeg = (ws: WebSocketLike): void => {
      const previous = transport.currentWs;
      if (lifecycle) {
        flush();
        cumulativeOffsetMs += Date.now() - legStartedAt;
        legMeta.get(ws)!.offsetMs = cumulativeOffsetMs;
      }
      transport.currentWs = ws;
      legStartedAt = Date.now();
      // Rotation fires no reconnect callback, so this is the only signal that clears a
      // lingering pre-swap partial caption.
      callbacks.onPartial?.('', '');
      flush();
      if (previous && previous !== ws) {
        if (lifecycle) lifecycle.retireLeg(previous);
        else closeWs(previous, { commit: true });
      }
      scheduleRotation();
    };

    const goTerminal = (error: unknown): void => {
      if (transport.terminated) return;
      if (lifecycle) lifecycle.terminal(error);
      else transport.terminated = true;
      teardownCapture();
      transport.currentWs = null;
      const message = error instanceof Error ? error.message : 'Realtime session ended';
      callbacks.onError?.({ error: { message } });
      notifyClose();
    };

    // Replace a dead leg with a fresh one (bounded backoff), mic never stopping. Keeps
    // cumulativeOffsetMs unchanged: the new session's restarted clock rewinds this leg's
    // ms labels, but display order is by sortOrder (utterance index), not startMs.
    const attemptReconnect = (): void => {
      if (transport.terminated || lifecycle?.finishing || reconnecting || rotating) return;
      reconnecting = true;
      callbacks.onReconnecting?.();
      withRetry(
        async () => {
          // Bail once stopped so a stop() mid-backoff can't keep opening sockets / fetching
          // tokens; a 4xx-shaped status makes the strategy give up immediately.
          if (transport.terminated || lifecycle?.finishing)
            throw Object.assign(new Error('session stopped'), { status: 499 });
          const state = await Network.getNetworkStateAsync();
          // Status-less error → retryable, so the loop waits for connectivity to return.
          if (state.isConnected === false) throw new Error('offline');
          const clientSecret = await fetchClientSecret();
          return openLeg(clientSecret);
        },
        {
          maxRetries: RECONNECT_MAX_RETRIES,
          initialDelay: RECONNECT_INITIAL_DELAY_MS,
          maxDelay: RECONNECT_MAX_DELAY_MS,
          ...createApiRetryStrategy(),
        },
      )
        .then((ws) => {
          reconnecting = false;
          if (transport.terminated || lifecycle?.finishing) {
            closeWs(ws); // resolved after stop() — abandon it
            return;
          }
          swapCurrentLeg(ws);
          callbacks.onReconnected?.();
        })
        .catch((error) => {
          reconnecting = false;
          if (transport.terminated) return;
          goTerminal(error); // budget exhausted / 4xx token — utterances still preserved
        });
    };

    const rollLeg = async (): Promise<void> => {
      if (transport.terminated || lifecycle?.finishing || reconnecting || rotating) return;
      rotating = true;
      // The default transport advances the offset before connecting; a recovery
      // lifecycle accounts for connection time when the replacement is swapped in.
      if (!lifecycle) cumulativeOffsetMs += Date.now() - legStartedAt;
      try {
        const clientSecret = await fetchClientSecret();
        const newWs = await openLeg(clientSecret);
        rotating = false;
        if (transport.terminated || lifecycle?.finishing) {
          closeWs(newWs);
          return;
        }
        swapCurrentLeg(newWs);
      } catch {
        rotating = false;
        if (transport.terminated) return;
        // The old leg is still live, so keep recording via a reconnect rather than dying.
        attemptReconnect();
      }
    };

    const handleLegClosed = async (ws: WebSocketLike, code: number | undefined): Promise<void> => {
      if (lifecycle && !lifecycle.legClosed(ws)) return;
      if (
        ws !== transport.currentWs ||
        transport.terminated ||
        lifecycle?.finishing ||
        rotating ||
        reconnecting
      )
        return;
      const sessionAgeMs = Date.now() - sessionStartedAt;
      let isConnected = true;
      try {
        const state = await Network.getNetworkStateAsync();
        isConnected = state.isConnected !== false;
      } catch {
        // Can't sample the network — assume connected; attemptReconnect re-gates.
      }
      if (ws !== transport.currentWs || transport.terminated || rotating || reconnecting) return; // re-check post-await
      const decision = classifyClose(code, isConnected, sessionAgeMs);
      if (decision === 'terminal') {
        goTerminal(new Error(`Realtime WebSocket closed (code ${code ?? 'unknown'})`));
      } else if (decision === 'rotate') {
        void rollLeg();
      } else {
        attemptReconnect();
      }
    };

    const stop = (): void => {
      if (transport.terminated) return;
      transport.terminated = true;
      const ws = transport.currentWs;
      flush();
      closeWs(ws, { commit: true });
      lifecycle?.stop();
      transport.currentWs = null;
      teardownCapture();
    };

    lifecycle = createLifecycle?.({
      opts,
      callbacks,
      sampleRate,
      transport,
      capture: LivePCMStreaming,
      reducer,
      flush,
      closeWs,
      teardownCapture,
      goTerminal,
    });
    lifecycle?.beforeToken();
    const firstSecret = await fetchClientSecret();
    lifecycle?.afterToken();

    // Start capture before opening the socket so speech during connect is buffered and
    // flushed on open. If the mic fails, abort before any socket exists.
    transport.frameSub = addPcmFrameListener((frame: PcmFrame) => {
      enqueuePcm(Buffer.from(frame.audio, 'base64'));
    });
    try {
      if (lifecycle) await lifecycle.startCapture();
      else await LivePCMStreaming.start(sampleRate);
    } catch (error) {
      lifecycle?.beforeFrameCleanup();
      transport.frameSub?.remove();
      transport.frameSub = null;
      lifecycle?.afterFrameCleanup();
      throw error;
    }

    sessionStartedAt = Date.now();
    transport.flushTimer = setInterval(flush, FLUSH_INTERVAL_MS);

    try {
      transport.currentWs = await openLeg(firstSecret);
    } catch (error) {
      teardownCapture();
      throw error;
    }

    legStartedAt = Date.now();
    flush(); // drain the cold-start buffer
    scheduleRotation();

    return lifecycle
      ? { stop, ...lifecycle.sessionMethods() }
      : { stop, utterances: reducer.utterances };
  };
}

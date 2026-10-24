/**
 * GPT-4o Realtime meeting transcription over a WebSocket with raw native PCM.
 *
 * A session spans one or more legs (one OpenAI ws + ephemeral token each). The mic,
 * event reducer, PCM ring buffer, and flush timer are session-scoped and outlive any
 * leg; only the active socket (currentWs) is swapped — on reconnect (network drop) or
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
  addPcmErrorListener,
  addPcmStopListener,
  DEFAULT_SAMPLE_RATE,
  type PcmFrame,
} from '../../../modules/live-pcm-streaming/src';
import { createRealtimeEventReducer } from './realtimeEvents';
import type { RealtimeCallbacks, RealtimeSession } from './realtimeEvents';
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

interface LegState {
  legIndex: number;
  offsetMs: number;
  legacyProtocol: boolean;
  closed: boolean;
  pendingItems: Set<string>;
  drain?: {
    promise: Promise<void>;
    complete: () => void;
    fail: (error: Error) => void;
    commitSent: boolean;
    acknowledged: boolean;
  };
}

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

const defaultWsFactory = (url: string, protocols: string[]): WebSocketLike =>
  new WebSocket(url, protocols) as unknown as WebSocketLike;

export async function startRealtimeMeetingWs(
  opts: {
    language?: string;
    model?: string;
    sampleRate?: number;
    noteId?: number;
    signal?: AbortSignal;
  } = {},
  callbacks: RealtimeCallbacks = {},
  deps: RealtimeMeetingDeps = {},
): Promise<RealtimeSession> {
  const sampleRate = opts.sampleRate ?? DEFAULT_SAMPLE_RATE;
  const wsFactory = deps.wsFactory ?? defaultWsFactory;

  const tokenBody = (): Record<string, unknown> => ({
    streams: 1,
    ...(opts.model ? { model: opts.model } : {}),
    ...(opts.language ? { language: opts.language } : {}),
  });

  const fetchClientSecret = async (): Promise<string> => {
    const { clientSecret } = await api.post<TokenResponse>(
      '/api/openai-realtime-token',
      tokenBody(),
    );
    return clientSecret;
  };

  // One reducer per session — this is why utterances survive every leg swap.
  const reducer = createRealtimeEventReducer(callbacks);
  const pcmRing = new PcmRingBuffer(pcmTailCapBytes(sampleRate));
  // Per-leg index + offset, keyed by socket so a replaced leg's late messages keep
  // their own leg's namespace/offset during a swap.
  const legMeta = new WeakMap<WebSocketLike, LegState>();
  const retiringLegs = new Map<WebSocketLike, Promise<void>>();
  const itemOrder = new Map<string, { leg: number; sequence: number }>();
  const orderedUtterances = () =>
    reducer.utterances().sort((a, b) => {
      const first = itemOrder.get(a.itemId)!;
      const second = itemOrder.get(b.itemId)!;
      return first.leg - second.leg || first.sequence - second.sequence;
    });

  let currentWs: WebSocketLike | null = null;
  // Leg mid-connect; tracked so a terminal stop closes it instead of leaking until timeout.
  let connectingWs: WebSocketLike | null = null;
  let flushTimer: ReturnType<typeof setInterval> | null = null;
  let rotationTimer: ReturnType<typeof setTimeout> | null = null;
  let frameSub: { remove(): void } | null = null;
  let stopSub: { remove(): void } | null = null;
  let errorSub: { remove(): void } | null = null;
  let terminalError: Error | null = null;
  let finishing = false;
  let finishPromise: Promise<void> | null = null;
  let coverageIncomplete = false;
  const checkDrain = (meta: LegState) => {
    if (meta.drain?.acknowledged && meta.pendingItems.size === 0) meta.drain.complete();
  };

  let legIndex = 0;
  let cumulativeOffsetMs = 0; // summed wall-clock duration of all prior legs
  let legStartedAt = 0;
  let sessionStartedAt = 0; // drives the rotate-vs-reconnect age

  // terminated makes stop()/goTerminal idempotent and cancels in-flight swaps;
  // rotating/reconnecting serialize swaps.
  let terminated = false;
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
    if (pcmRing.byteLength < expectedBytes) coverageIncomplete = true;
  };

  const flush = (): void => {
    const ws = currentWs;
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
      // We cannot know whether the server received this audio; never claim full coverage.
      coverageIncomplete = true;
    }
  };

  const closeWs = (ws: WebSocketLike | null, options?: { commit?: boolean }): void => {
    if (!ws) return;
    const meta = legMeta.get(ws);
    if (meta) meta.closed = true;
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

  // Each retiring/active leg has its own ordered barrier. Late events from one
  // socket must never acknowledge another socket's final commit.
  const drainLeg = (ws: WebSocketLike): Promise<void> => {
    const meta = legMeta.get(ws)!;
    if (meta.drain) return meta.drain.promise;
    if (ws.readyState !== WS_OPEN)
      return Promise.reject(new Error('Connection closed before the final transcript.'));
    let complete!: () => void;
    let fail!: (error: Error) => void;
    const promise = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => fail(new Error('Final transcript timed out.')), 15000);
      complete = () => {
        clearTimeout(timer);
        resolve();
      };
      fail = (error) => {
        clearTimeout(timer);
        reject(error);
      };
    });
    meta.drain = { promise, complete, fail, commitSent: false, acknowledged: false };
    try {
      // Disabling VAD is an ordering barrier before the explicit final commit.
      ws.send(
        JSON.stringify(
          meta.legacyProtocol
            ? { type: 'transcription_session.update', session: { turn_detection: null } }
            : {
                type: 'session.update',
                session: {
                  type: 'transcription',
                  audio: { input: { turn_detection: null } },
                },
              },
        ),
      );
    } catch (error) {
      fail(error instanceof Error ? error : new Error(String(error)));
    }
    return promise;
  };

  const closeAllLegs = (error: Error): void => {
    for (const ws of [currentWs, ...retiringLegs.keys()]) {
      if (!ws) continue;
      legMeta.get(ws)?.drain?.fail(error);
      closeWs(ws);
    }
    currentWs = null;
  };

  // Mic + timers only, never the socket — a reconnectable close must not stop capture.
  const teardownCapture = (): void => {
    opts.signal?.removeEventListener('abort', abort);
    frameSub?.remove();
    frameSub = null;
    stopSub?.remove();
    stopSub = null;
    errorSub?.remove();
    errorSub = null;
    LivePCMStreaming.stop().catch(() => {});
    if (flushTimer) {
      clearInterval(flushTimer);
      flushTimer = null;
    }
    if (rotationTimer) {
      clearTimeout(rotationTimer);
      rotationTimer = null;
    }
    // Close any in-flight connect so a stop doesn't leave it to time out (and re-enter retry).
    if (connectingWs) {
      closeWs(connectingWs);
      connectingWs = null;
    }
  };

  const handleMessage = (ws: WebSocketLike, event: { data: string }): void => {
    const meta = legMeta.get(ws);
    if (!meta || meta.closed || terminated) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(event.data);
    } catch {
      return;
    }
    const evt = parsed as {
      type?: string;
      item_id?: string;
      error?: { code?: string };
      session?: { turn_detection?: unknown; audio?: { input?: { turn_detection?: unknown } } };
    };
    if (evt.type === 'session.created') meta.legacyProtocol = false;
    const drain = meta.drain;
    if (
      drain &&
      !drain.commitSent &&
      (evt.type === 'transcription_session.updated' || evt.type === 'session.updated') &&
      (meta.legacyProtocol
        ? evt.session?.turn_detection === null
        : evt.session?.audio?.input?.turn_detection === null)
    ) {
      drain.commitSent = true;
      drain.acknowledged = false;
      try {
        ws.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
      } catch (error) {
        drain.fail(error instanceof Error ? error : new Error(String(error)));
      }
      return;
    }
    if (evt.type === 'error' && evt.error?.code === 'input_audio_buffer_commit_empty') {
      if (drain?.commitSent) {
        drain.acknowledged = true;
        checkDrain(meta);
      }
      return; // benign: our commit hit an already-drained buffer
    }
    const rewritten = applyLegOffset(parsed as object, meta.offsetMs) as { item_id?: unknown };
    if (typeof rewritten.item_id === 'string') {
      rewritten.item_id = namespaceItemId(meta.legIndex, rewritten.item_id);
    }
    const itemId = rewritten.item_id;
    if (typeof itemId === 'string') {
      if (!itemOrder.has(itemId))
        itemOrder.set(itemId, { leg: meta.legIndex, sequence: itemOrder.size });
      if (
        evt.type === 'input_audio_buffer.speech_started' ||
        evt.type === 'input_audio_buffer.committed' ||
        evt.type === 'conversation.item.input_audio_transcription.delta'
      )
        meta.pendingItems.add(itemId);
      if (
        evt.type === 'conversation.item.input_audio_transcription.completed' ||
        evt.type === 'conversation.item.input_audio_transcription.failed'
      )
        meta.pendingItems.delete(itemId);
    }
    if (evt.type === 'conversation.item.input_audio_transcription.failed') {
      goTerminal(new Error('Part of the meeting could not be transcribed.'));
      return;
    }
    if (drain?.commitSent && evt.type === 'input_audio_buffer.committed') drain.acknowledged = true;
    reducer.handleEvent(rewritten);
    if (evt.type === 'conversation.item.input_audio_transcription.completed')
      callbacks.onUtterances?.(orderedUtterances());
    if (evt.type === 'error') {
      coverageIncomplete = true;
      drain?.fail(new Error('Meeting finalization failed.'));
    }
    checkDrain(meta);
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
      legMeta.set(ws, { ...meta, legacyProtocol: true, closed: false, pendingItems: new Set() });
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
    if (rotationTimer) clearTimeout(rotationTimer);
    rotationTimer = setTimeout(() => {
      void rollLeg();
    }, ROTATION_MS);
  };

  // New audio goes to the new leg while the retiring leg finishes its transcript.
  const swapCurrentLeg = (ws: WebSocketLike): void => {
    const previous = currentWs;
    flush(); // queued audio still belongs to the previous live leg
    cumulativeOffsetMs += Date.now() - legStartedAt;
    legMeta.get(ws)!.offsetMs = cumulativeOffsetMs;
    currentWs = ws;
    legStartedAt = Date.now();
    callbacks.onPartial?.('', '');
    flush(); // replays buffered audio when the previous leg was already disconnected
    if (previous && previous !== ws) {
      const retiring = drainLeg(previous)
        .catch(() => {
          coverageIncomplete = true;
        })
        .finally(() => {
          closeWs(previous);
          retiringLegs.delete(previous);
        });
      retiringLegs.set(previous, retiring);
    }
    scheduleRotation();
  };

  const goTerminal = (error: unknown): void => {
    if (terminated) return;
    terminalError = error instanceof Error ? error : new Error(String(error));
    terminated = true;
    closeAllLegs(terminalError);
    teardownCapture();
    const message = error instanceof Error ? error.message : 'Realtime session ended';
    callbacks.onError?.({ error: { message } });
    notifyClose();
  };

  // Replace a dead leg with a fresh one (bounded backoff), mic never stopping. Keeps
  // the transcript accumulated by earlier legs.
  const attemptReconnect = (): void => {
    if (terminated || finishing || reconnecting || rotating) return;
    reconnecting = true;
    callbacks.onReconnecting?.();
    withRetry(
      async () => {
        // Bail once stopped so a stop() mid-backoff can't keep opening sockets / fetching
        // tokens; a 4xx-shaped status makes the strategy give up immediately.
        if (terminated || finishing)
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
        if (terminated || finishing) {
          closeWs(ws); // resolved after stop() — abandon it
          return;
        }
        swapCurrentLeg(ws);
        callbacks.onReconnected?.();
      })
      .catch((error) => {
        reconnecting = false;
        if (terminated) return;
        goTerminal(error); // budget exhausted / 4xx token — utterances still preserved
      });
  };

  const rollLeg = async (): Promise<void> => {
    if (terminated || finishing || reconnecting || rotating) return;
    rotating = true;
    try {
      const clientSecret = await fetchClientSecret();
      const newWs = await openLeg(clientSecret);
      rotating = false;
      if (terminated || finishing) {
        closeWs(newWs);
        return;
      }
      swapCurrentLeg(newWs);
    } catch {
      rotating = false;
      if (terminated) return;
      // The old leg is still live, so keep recording via a reconnect rather than dying.
      attemptReconnect();
    }
  };

  const handleLegClosed = async (ws: WebSocketLike, code: number | undefined): Promise<void> => {
    const meta = legMeta.get(ws);
    if (terminated || meta?.closed) return;
    coverageIncomplete = true;
    meta?.drain?.fail(new Error('Connection closed before the final transcript.'));
    if (ws !== currentWs || finishing || rotating || reconnecting) return;
    const sessionAgeMs = Date.now() - sessionStartedAt;
    let isConnected = true;
    try {
      const state = await Network.getNetworkStateAsync();
      isConnected = state.isConnected !== false;
    } catch {
      // Can't sample the network — assume connected; attemptReconnect re-gates.
    }
    if (ws !== currentWs || terminated || rotating || reconnecting) return; // re-check post-await
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
    if (terminated) return;
    terminated = true;
    flush();
    closeWs(currentWs, { commit: true });
    closeAllLegs(new Error('Meeting interrupted.'));
    teardownCapture();
  };

  const finish = (): Promise<void> => {
    if (finishPromise) return finishPromise;
    if (terminated) return terminalError ? Promise.reject(terminalError) : Promise.resolve();
    finishing = true;
    if (rotationTimer) clearTimeout(rotationTimer);
    finishPromise = (async () => {
      try {
        await LivePCMStreaming.stop();
        frameSub?.remove();
        frameSub = null;
        if (flushTimer) clearInterval(flushTimer);
        flush();
        const ws = currentWs;
        const results = await Promise.allSettled([
          ...retiringLegs.values(),
          ws ? drainLeg(ws) : Promise.reject(new Error('Connection unavailable.')),
        ]);
        const failure = results.find((result) => result.status === 'rejected');
        if (failure?.status === 'rejected') throw failure.reason;
        if (coverageIncomplete)
          throw new Error('The connection was interrupted. The transcript may be incomplete.');
      } finally {
        terminated = true;
        closeAllLegs(new Error('Meeting ended.'));
        teardownCapture();
      }
    })();
    return finishPromise;
  };

  const abort = () => {
    goTerminal(new Error('Meeting cancelled.'));
  };
  if (opts.signal?.aborted) throw new Error('Meeting cancelled.');
  const firstSecret = await fetchClientSecret();
  if (opts.signal?.aborted) throw new Error('Meeting cancelled.');
  opts.signal?.addEventListener('abort', abort, { once: true });

  // Start capture before opening the socket so speech during connect is buffered and
  // flushed on open. If the mic fails, abort before any socket exists.
  frameSub = addPcmFrameListener((frame: PcmFrame) => {
    enqueuePcm(Buffer.from(frame.audio, 'base64'));
  });
  try {
    stopSub = addPcmStopListener?.(() => callbacks.onStopRequested?.()) ?? null;
    errorSub = addPcmErrorListener?.(({ message }) => goTerminal(new Error(message))) ?? null;
    await LivePCMStreaming.start(sampleRate, opts.noteId, opts.signal);
    if (terminated || opts.signal?.aborted) {
      await LivePCMStreaming.stop();
      throw new Error('Meeting cancelled.');
    }
  } catch (error) {
    opts.signal?.removeEventListener('abort', abort);
    frameSub?.remove();
    frameSub = null;
    stopSub?.remove();
    stopSub = null;
    errorSub?.remove();
    errorSub = null;
    throw error;
  }

  sessionStartedAt = Date.now();
  flushTimer = setInterval(flush, FLUSH_INTERVAL_MS);

  try {
    currentWs = await openLeg(firstSecret);
  } catch (error) {
    teardownCapture();
    throw error;
  }

  legStartedAt = Date.now();
  flush(); // drain the cold-start buffer
  scheduleRotation();

  return { stop, finish, utterances: orderedUtterances };
}

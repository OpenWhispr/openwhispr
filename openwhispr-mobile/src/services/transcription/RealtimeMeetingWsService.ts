/**
 * GPT-4o Realtime meeting transcription over a WebSocket with raw native PCM.
 *
 * A session spans one or more legs (one OpenAI ws + ephemeral token each). The mic,
 * event reducer, PCM ring buffer, and flush timer are session-scoped and outlive any
 * leg; only the active socket (currentWs) is swapped — on reconnect (network drop) or
 * rotation (before OpenAI's ~60-min session cap). Reconnects never give up on their own:
 * only a refused token or a policy close ends the session early. A leg that is retired
 * (rotation, Stop) is committed and kept open until its last turn is transcribed, up to
 * STOP_FLUSH_TIMEOUT_MS, so the final words of a leg are not cut off. One reducer means utterances
 * accumulate across every leg; each leg's messages are rewritten first (item_id
 * namespaced, timings offset onto the capture clock) so a fresh leg's restarted ids/clock
 * don't collide with or rewind the transcript.
 *
 * Auth rides in the WS subprotocol, not a header — RN mangles custom WS headers on iOS.
 */
import { Buffer } from 'buffer';
import * as Network from 'expo-network';
import { api } from '@/lib/apiClient';
import { acquireCaptureLease, releaseCaptureLease } from '@/lib/captureLease';
import { withRetry, createApiRetryStrategy } from '@/lib/retry';
import {
  LivePCMStreaming,
  addPcmFrameListener,
  addCaptureStateListener,
  DEFAULT_SAMPLE_RATE,
  type PcmFrame,
} from '../../../modules/live-pcm-streaming/src';
import { transcriptionPolicyErrorFromApiError } from './policyErrors';
import { createRealtimeEventReducer } from './realtimeEvents';
import type { RealtimeCallbacks, RealtimeSession } from './realtimeEvents';
import {
  PcmRingBuffer,
  applyLegOffset,
  classifyClose,
  legItemPrefix,
  namespaceItemId,
  pcmTailCapBytes,
  shortLegBackoffMs,
  ROTATION_MS,
  RECONNECT_MAX_RETRIES,
  RECONNECT_INITIAL_DELAY_MS,
  RECONNECT_MAX_DELAY_MS,
  CONNECT_TIMEOUT_MS,
  STOP_FLUSH_TIMEOUT_MS,
  SHORT_LEG_MS,
} from './realtimeReconnect';

export type { RealtimeCallbacks, RealtimeSession, RealtimeUtterance } from './realtimeEvents';

const OPENAI_REALTIME_WS_URL = 'wss://api.openai.com/v1/realtime?intent=transcription';
// bufferedAmount is undefined on RN, so batching sends at this cadence is the only
// backpressure control available.
const FLUSH_INTERVAL_MS = 150;
const WS_OPEN = 1; // WebSocket.OPEN, decoupled from the global so tests can inject a fake

// The shared API strategy treats every 4xx as final. A 408 is the token endpoint timing
// out, which a retry can fix; a 429 stays final (here it means the plan's word limit).
const apiRetryStrategy = createApiRetryStrategy();
const shouldRetryReconnect = (error: unknown): boolean => {
  const status = (error as { status?: unknown } | null)?.status;
  if (status === 408) return true;
  return apiRetryStrategy.shouldRetry?.(error) ?? true;
};

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
  opts: { language?: string; model?: string; sampleRate?: number } = {},
  callbacks: RealtimeCallbacks = {},
  deps: RealtimeMeetingDeps = {},
): Promise<RealtimeSession> {
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
  const bytesToMs = (bytes: number): number => Math.floor((bytes * 1000) / (sampleRate * 2));
  let capturedBytes = 0;
  // Merged chunks a failed send threw away; the ring counts its own evictions.
  let sendDroppedBytes = 0;
  // Per-leg index + offset, keyed by socket so a replaced leg's late messages keep
  // their own leg's namespace/offset during a swap.
  const legMeta = new WeakMap<WebSocketLike, { legIndex: number; offsetMs: number }>();

  let currentWs: WebSocketLike | null = null;
  // Leg mid-connect; tracked so a terminal stop closes it instead of leaking until timeout.
  let connectingWs: WebSocketLike | null = null;
  let flushTimer: ReturnType<typeof setInterval> | null = null;
  let rotationTimer: ReturnType<typeof setTimeout> | null = null;
  let reconnectDelayTimer: ReturnType<typeof setTimeout> | null = null;
  let rotateDelayTimer: ReturnType<typeof setTimeout> | null = null;
  // Legs in a row the server closed within SHORT_LEG_MS of opening.
  let consecutiveShortLegs = 0;
  let frameSub: { remove(): void } | null = null;
  let captureSub: { remove(): void } | null = null;
  let micStopped = false;
  // Flips false on the first release so every exit path can call releaseLease safely.
  let leaseHeld = false;
  // Legs committed and waiting for their last turn; `sawReply` is set once the server
  // answered our commit (committed or commit_empty) on that leg.
  const drains = new Set<{ ws: WebSocketLike; sawReply: boolean; finish: () => void }>();
  const drainPromises = new Set<Promise<void>>();
  let stopPromise: Promise<void> | null = null;

  let legIndex = 0;
  let legStartedAt = 0;
  let sessionStartedAt = 0; // drives the rotate-vs-reconnect age

  // terminated makes stop()/goTerminal idempotent and cancels in-flight swaps (stop sets it
  // before the last turn drains, so nothing reconnects or rotates meanwhile);
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
    capturedBytes += buf.length;
    pcmRing.push(buf);
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
      // Socket may have closed between the readyState check and send; drop the chunk.
      sendDroppedBytes += merged.length;
    }
  };

  const closeWs = (ws: WebSocketLike | null): void => {
    if (!ws) return;
    try {
      ws.close();
    } catch {
      // best-effort teardown
    }
  };

  // A reply alone isn't enough: a turn the server's VAD committed before ours may still be
  // mid-transcription when our commit comes back empty.
  const settleDrains = (): void => {
    if (reducer.pendingItemCount() > 0) return;
    for (const drain of drains) {
      if (drain.sawReply) drain.finish();
    }
  };

  const markDrainReply = (ws: WebSocketLike): void => {
    for (const drain of drains) {
      if (drain.ws === ws) drain.sawReply = true;
    }
  };

  // A closed leg never finishes its pending turns; left in place they would hold every
  // later drain to its full timeout.
  const forgetLegTurns = (ws: WebSocketLike): void => {
    const meta = legMeta.get(ws);
    if (meta) reducer.dropPendingItems(legItemPrefix(meta.legIndex));
  };

  const finishDrainsFor = (ws: WebSocketLike): void => {
    for (const drain of drains) {
      if (drain.ws === ws) drain.finish();
    }
  };

  // Commit a leg's buffer and close it once its last turn is transcribed, the server closes
  // it, or STOP_FLUSH_TIMEOUT_MS passes. A leg that isn't open just closes.
  const finishLeg = (ws: WebSocketLike): Promise<void> => {
    if (ws.readyState !== WS_OPEN) {
      closeWs(ws);
      return Promise.resolve();
    }
    try {
      ws.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
    } catch {
      closeWs(ws);
      return Promise.resolve();
    }
    const promise = new Promise<void>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | null = null;
      const drain = {
        ws,
        sawReply: false,
        finish: (): void => {
          if (!drains.delete(drain)) return;
          if (timer) clearTimeout(timer);
          closeWs(ws);
          forgetLegTurns(ws);
          resolve();
          settleDrains();
        },
      };
      drains.add(drain);
      timer = setTimeout(drain.finish, STOP_FLUSH_TIMEOUT_MS);
    });
    drainPromises.add(promise);
    void promise.then(() => drainPromises.delete(promise));
    return promise;
  };

  const releaseLease = (): void => {
    if (!leaseHeld) return;
    leaseHeld = false;
    releaseCaptureLease('meeting-cloud');
  };

  const stopMic = (): void => {
    if (micStopped) return;
    micStopped = true;
    frameSub?.remove();
    frameSub = null;
    captureSub?.remove();
    captureSub = null;
    // Release only once the native stop has settled: re-arming the keyboard's warm mic while
    // this teardown is still deactivating the audio session is the bug the lease prevents.
    Promise.resolve(LivePCMStreaming.stop())
      .catch(() => {})
      .finally(releaseLease);
  };

  const clearTimers = (): void => {
    if (flushTimer) {
      clearInterval(flushTimer);
      flushTimer = null;
    }
    if (rotationTimer) {
      clearTimeout(rotationTimer);
      rotationTimer = null;
    }
    if (reconnectDelayTimer) {
      clearTimeout(reconnectDelayTimer);
      reconnectDelayTimer = null;
    }
    if (rotateDelayTimer) {
      clearTimeout(rotateDelayTimer);
      rotateDelayTimer = null;
    }
    // Close any in-flight connect so a stop doesn't leave it to time out (and re-enter retry).
    if (connectingWs) {
      closeWs(connectingWs);
      connectingWs = null;
    }
  };

  // Mic + timers only, never the socket — a reconnectable close must not stop capture.
  const teardownCapture = (): void => {
    stopMic();
    clearTimers();
  };

  const handleMessage = (ws: WebSocketLike, event: { data: string }): void => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(event.data);
    } catch {
      return;
    }
    const evt = parsed as { type?: string; error?: { code?: string } };
    if (evt.type === 'error' && evt.error?.code === 'input_audio_buffer_commit_empty') {
      // Benign: our commit hit an already-drained buffer.
      markDrainReply(ws);
      settleDrains();
      return;
    }
    const meta = legMeta.get(ws) ?? { legIndex: 0, offsetMs: 0 };
    const rewritten = applyLegOffset(parsed as object, meta.offsetMs) as { item_id?: unknown };
    if (typeof rewritten.item_id === 'string') {
      rewritten.item_id = namespaceItemId(meta.legIndex, rewritten.item_id);
    }
    reducer.handleEvent(rewritten);
    if (evt.type === 'input_audio_buffer.committed') markDrainReply(ws);
    if (drains.size > 0) settleDrains();
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
        // A leg the server closed has nothing more to deliver.
        forgetLegTurns(ws);
        finishDrainsFor(ws);
        settleDrains();
        void handleLegClosed(ws, code);
      };
    });

  // The offset is set when the leg is swapped in, once it is known which audio it gets first.
  const openLeg = (clientSecret: string): Promise<WebSocketLike> => {
    legIndex += 1;
    return connectLeg(clientSecret, { legIndex, offsetMs: 0 });
  };

  const scheduleRotation = (): void => {
    if (rotationTimer) clearTimeout(rotationTimer);
    rotationTimer = setTimeout(() => {
      void rollLeg();
    }, ROTATION_MS);
  };

  // Point the flush loop at a fresh, open leg and retire the previous one. On a
  // reconnect the previous leg is already dead so finishLeg just closes it; on a rotation
  // (or a rotation that fell back to reconnect while the old leg was live) it commits it
  // and closes it once its last turn is in. Always re-arm the rotation clock onto the new leg.
  const swapCurrentLeg = (ws: WebSocketLike): void => {
    const previous = currentWs;
    // The server's clock restarts at 0 with the first audio this leg receives: whatever the
    // ring still holds, which is the newest audio captured. Its offset is therefore that
    // audio's position in the capture, so timings stay on one clock across every leg.
    const meta = legMeta.get(ws);
    if (meta) meta.offsetMs = bytesToMs(capturedBytes - pcmRing.byteLength);
    currentWs = ws;
    legStartedAt = Date.now();
    // Rotation fires no reconnect callback, so this is the only signal that clears a
    // lingering pre-swap partial caption.
    callbacks.onPartial?.('', '');
    flush();
    if (previous && previous !== ws) {
      void finishLeg(previous);
    }
    scheduleRotation();
  };

  const goTerminal = (error: unknown): void => {
    if (terminated) return;
    terminated = true;
    teardownCapture();
    currentWs = null;
    const message = error instanceof Error ? error.message : 'Realtime session ended';
    callbacks.onError?.({ error: { message } });
    notifyClose();
  };

  // Replace a dead leg with a fresh one (capped backoff, no attempt limit), mic never stopping.
  // `delayMs` holds the first attempt back (after short-lived legs); clearTimers cancels it.
  const attemptReconnect = (delayMs = 0): void => {
    if (terminated || reconnecting || rotating) return;
    reconnecting = true;
    callbacks.onReconnecting?.();
    if (delayMs > 0) {
      reconnectDelayTimer = setTimeout(() => {
        reconnectDelayTimer = null;
        if (terminated) {
          reconnecting = false;
          return;
        }
        runReconnect();
      }, delayMs);
      return;
    }
    runReconnect();
  };

  const runReconnect = (): void => {
    withRetry(
      async () => {
        // Bail once stopped so a stop() mid-backoff can't keep opening sockets / fetching
        // tokens; a 4xx-shaped status makes the strategy give up immediately.
        if (terminated) throw Object.assign(new Error('session stopped'), { status: 499 });
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
        shouldRetry: shouldRetryReconnect,
      },
    )
      .then((ws) => {
        reconnecting = false;
        if (terminated) {
          closeWs(ws); // resolved after stop() — abandon it
          return;
        }
        swapCurrentLeg(ws);
        callbacks.onReconnected?.();
      })
      .catch((error) => {
        reconnecting = false;
        if (terminated) return;
        goTerminal(error); // 4xx token — utterances still preserved
      });
  };

  const rollLeg = async (): Promise<void> => {
    if (terminated || reconnecting || rotating) return;
    rotating = true;
    try {
      const clientSecret = await fetchClientSecret();
      const newWs = await openLeg(clientSecret);
      rotating = false;
      if (terminated) {
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
    if (ws !== currentWs || terminated || rotating || reconnecting) return;
    const sessionAgeMs = Date.now() - sessionStartedAt;
    const legAgeMs = Date.now() - legStartedAt;
    let isConnected = true;
    try {
      const state = await Network.getNetworkStateAsync();
      isConnected = state.isConnected !== false;
    } catch {
      // Can't sample the network — assume connected; attemptReconnect re-gates.
    }
    if (ws !== currentWs || terminated || rotating || reconnecting) return; // re-check post-await
    consecutiveShortLegs = legAgeMs < SHORT_LEG_MS ? consecutiveShortLegs + 1 : 0;
    const decision = classifyClose(code, isConnected, sessionAgeMs);
    if (decision === 'terminal') {
      goTerminal(new Error(`Realtime WebSocket closed (code ${code ?? 'unknown'})`));
    } else if (decision === 'rotate') {
      // Past the rotation age every close rotates, so a server that accepts and drops every
      // leg would otherwise get an unthrottled token-mint loop for the rest of the meeting.
      const delayMs = shortLegBackoffMs(consecutiveShortLegs);
      if (delayMs === 0) {
        void rollLeg();
        return;
      }
      // The dead leg's scheduled rotation must not jump the wait; the swap re-arms it.
      if (rotationTimer) {
        clearTimeout(rotationTimer);
        rotationTimer = null;
      }
      rotateDelayTimer = setTimeout(() => {
        rotateDelayTimer = null;
        void rollLeg();
      }, delayMs);
    } else {
      attemptReconnect(shortLegBackoffMs(consecutiveShortLegs));
    }
  };

  const finishSession = async (): Promise<void> => {
    // The mic goes first so nothing more is captured, then the held audio is sent and
    // committed so the last turn is transcribed before the socket closes.
    stopMic();
    clearTimers();
    flush();
    const ws = currentWs;
    currentWs = null;
    if (ws) void finishLeg(ws);
    // Also waits for a leg a recent rotation is still retiring.
    await Promise.all([...drainPromises]);
  };

  const stop = (): Promise<void> => {
    if (stopPromise) return stopPromise;
    if (terminated) return Promise.resolve();
    terminated = true;
    stopPromise = finishSession();
    return stopPromise;
  };

  const firstSecret = await fetchClientSecret();

  // Start capture before opening the socket so speech during connect is buffered and
  // flushed on open. If the mic fails, abort before any socket exists.
  frameSub = addPcmFrameListener((frame: PcmFrame) => {
    enqueuePcm(Buffer.from(frame.audio, 'base64'));
  });
  captureSub = addCaptureStateListener((event) => {
    callbacks.onCaptureState?.({ capturing: event.state === 'capturing', reason: event.reason });
  });
  await acquireCaptureLease('meeting-cloud');
  leaseHeld = true;
  try {
    await LivePCMStreaming.start(sampleRate);
  } catch (error) {
    frameSub?.remove();
    frameSub = null;
    captureSub?.remove();
    captureSub = null;
    releaseLease();
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

  return {
    stop,
    utterances: reducer.utterances,
    capturedMs: () => bytesToMs(capturedBytes),
    droppedMs: () => bytesToMs(pcmRing.droppedBytes + sendDroppedBytes),
  };
}

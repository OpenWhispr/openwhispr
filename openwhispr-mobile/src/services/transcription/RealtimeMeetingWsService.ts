import { createProviderCredentialScope } from '@/services/providers/ProviderCredentialScope';
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
import type { InferenceRoute } from '@shared/ai/routing';
import * as Network from 'expo-network';
import { api } from '@/lib/apiClient';
import { withRetry, createApiRetryStrategy } from '@/lib/retry';
import {
  LivePCMStreaming,
  addPcmFrameListener,
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
import {
  createRealtimeProviderProtocol,
  type RealtimeProviderOptions,
  type RealtimeProviderProtocol,
  type RealtimeWireData,
} from './RealtimeProviderProtocol';
import { getProviderCredential } from '@/services/providers/ProviderCredentials';
import { requestProviderNative } from '@/services/providers/NativeProviderTransport';

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
  send: (data: RealtimeWireData) => void;
  close: (code?: number, reason?: string) => void;
  onopen: ((event?: unknown) => void) | null;
  onmessage: ((event: { data: string }) => void) | null;
  onerror: ((event?: unknown) => void) | null;
  onclose: ((event: { code?: number }) => void) | null;
}

export interface RealtimeMeetingDeps {
  wsFactory?: (url: string, protocols: string[]) => WebSocketLike;
  protocolFactory?: (
    route: Extract<InferenceRoute, { mode: 'providers' }>,
    options: RealtimeProviderOptions,
  ) => Promise<RealtimeProviderProtocol>;
}

const defaultWsFactory = (url: string, protocols: string[]): WebSocketLike =>
  new WebSocket(url, protocols) as unknown as WebSocketLike;

export async function startRealtimeMeetingWs(
  opts: {
    language?: string;
    model?: string;
    sampleRate?: number;
    route?: Extract<InferenceRoute, { mode: 'providers' }>;
  } = {},
  callbacks: RealtimeCallbacks = {},
  deps: RealtimeMeetingDeps = {},
): Promise<RealtimeSession> {
  const sampleRate = opts.sampleRate ?? DEFAULT_SAMPLE_RATE;
  const wsFactory = deps.wsFactory ?? defaultWsFactory;
  const routeSnapshot = opts.route ? { ...opts.route } : undefined;
  const credentialScope = createProviderCredentialScope(routeSnapshot?.credentialRef);
  const protocolFactory =
    deps.protocolFactory ??
    ((route, options) =>
      createRealtimeProviderProtocol(route, options, {
        getCredential: getProviderCredential,
        request: requestProviderNative,
      }));

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

  const prepareProtocol = async (): Promise<RealtimeProviderProtocol> => {
    if (routeSnapshot) {
      return credentialScope.run(() =>
        protocolFactory(routeSnapshot, {
          language: opts.language,
          sampleRate,
          signal: credentialScope.signal,
        }),
      );
    }
    const clientSecret = await fetchClientSecret();
    return {
      providerId: 'openwhispr',
      connection: {
        url: OPENAI_REALTIME_WS_URL,
        protocols: ['realtime', `openai-insecure-api-key.${clientSecret}`],
        waitForReadyEvent: false,
      },
      onOpenMessages: [],
      encodeAudio: (bytes) =>
        JSON.stringify({
          type: 'input_audio_buffer.append',
          audio: Buffer.from(bytes).toString('base64'),
        }),
      finalizeMessages: [JSON.stringify({ type: 'input_audio_buffer.commit' })],
      normalize: (message) => [message],
    };
  };

  // One reducer per session — this is why utterances survive every leg swap.
  const reducer = createRealtimeEventReducer(callbacks);
  const pcmRing = new PcmRingBuffer(pcmTailCapBytes(sampleRate));
  // Per-leg index + offset, keyed by socket so a replaced leg's late messages keep
  // their own leg's namespace/offset during a swap.
  const legMeta = new WeakMap<
    WebSocketLike,
    { legIndex: number; offsetMs: number; protocol: RealtimeProviderProtocol }
  >();

  let currentWs: WebSocketLike | null = null;
  // Leg mid-connect; tracked so a terminal stop closes it instead of leaking until timeout.
  let connectingWs: WebSocketLike | null = null;
  let flushTimer: ReturnType<typeof setInterval> | null = null;
  let rotationTimer: ReturnType<typeof setTimeout> | null = null;
  let frameSub: { remove(): void } | null = null;

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
      const protocol = legMeta.get(ws)?.protocol;
      if (!protocol) return;
      ws.send(protocol.encodeAudio(new Uint8Array(merged)));
    } catch {
      // Socket may have closed between the readyState check and send; drop the chunk.
    }
  };

  const closeWs = (ws: WebSocketLike | null, options?: { commit?: boolean }): void => {
    if (!ws) return;
    try {
      const protocol = legMeta.get(ws)?.protocol;
      if (options?.commit && ws.readyState === WS_OPEN) {
        for (const message of protocol?.finalizeMessages ?? []) ws.send(message);
      }
      ws.close();
    } catch {
      // best-effort teardown
    }
  };

  // Mic + timers only, never the socket — a reconnectable close must not stop capture.
  const teardownCapture = (): void => {
    credentialScope.dispose();
    credentialScope.signal.removeEventListener('abort', handleCredentialChange);
    frameSub?.remove();
    frameSub = null;
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
    if (terminated) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(event.data);
    } catch {
      return;
    }
    const meta = legMeta.get(ws);
    if (!meta) return;
    for (const normalized of meta.protocol.normalize(parsed)) {
      const evt = normalized as {
        type?: string;
        item_id?: string;
        transcript?: string;
        error?: { code?: string };
      };
      if (evt.type === 'provider.ready') continue;
      if (evt.type === 'provider.partial') {
        callbacks.onDebug?.(normalized);
        callbacks.onPartial?.(
          evt.transcript ?? '',
          namespaceItemId(meta.legIndex, evt.item_id ?? 'active'),
        );
        continue;
      }
      if (evt.type === 'error' && evt.error?.code === 'input_audio_buffer_commit_empty') continue;
      const rewritten = applyLegOffset(normalized as object, meta.offsetMs) as {
        item_id?: unknown;
      };
      if (typeof rewritten.item_id === 'string') {
        rewritten.item_id = namespaceItemId(meta.legIndex, rewritten.item_id);
      }
      reducer.handleEvent(rewritten);
    }
  };

  // Opens one leg; resolves on open, rejects on pre-open close/error/timeout. Does NOT
  // tear down capture on close — a post-open close routes to handleLegClosed.
  const connectLeg = (
    protocol: RealtimeProviderProtocol,
    meta: { legIndex: number; offsetMs: number; protocol: RealtimeProviderProtocol },
  ): Promise<WebSocketLike> =>
    new Promise<WebSocketLike>((resolve, reject) => {
      const ws = protocol.connection.socketFactory
        ? protocol.connection.socketFactory()
        : wsFactory(protocol.connection.url, protocol.connection.protocols);
      legMeta.set(ws, meta);
      connectingWs = ws;
      let settled = false;
      let timer: ReturnType<typeof setTimeout>;
      const settle = (): void => {
        settled = true;
        clearTimeout(timer);
        credentialScope.signal.removeEventListener('abort', abortConnect);
        if (connectingWs === ws) connectingWs = null;
      };
      const abortConnect = (): void => {
        if (settled) return;
        settle();
        closeWs(ws);
        reject(new DOMException('Provider credential changed.', 'AbortError'));
      };
      credentialScope.signal.addEventListener('abort', abortConnect, { once: true });
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
        try {
          for (const message of protocol.onOpenMessages) ws.send(message);
          if (!protocol.connection.waitForReadyEvent) {
            settle();
            resolve(ws);
          }
        } catch {
          settle();
          reject(new Error('Realtime provider configuration failed'));
        }
      };
      ws.onmessage = (e) => {
        if (!settled && protocol.connection.waitForReadyEvent) {
          try {
            const normalized = protocol.normalize(JSON.parse(e.data));
            if (
              normalized.some((event) => (event as { type?: string }).type === 'provider.ready')
            ) {
              settle();
              resolve(ws);
              return;
            }
          } catch {
            // Let the normal handler ignore malformed provider messages.
          }
        }
        handleMessage(ws, e);
      };
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

  const openLeg = async (preparedProtocol?: RealtimeProviderProtocol): Promise<WebSocketLike> => {
    credentialScope.assertActive();
    const protocol = preparedProtocol ?? (await prepareProtocol());
    credentialScope.assertActive();
    if (terminated) throw Object.assign(new Error('session stopped'), { status: 499 });
    legIndex += 1;
    return connectLeg(protocol, { legIndex, offsetMs: cumulativeOffsetMs, protocol });
  };

  const scheduleRotation = (): void => {
    if (rotationTimer) clearTimeout(rotationTimer);
    rotationTimer = setTimeout(() => {
      void rollLeg();
    }, ROTATION_MS);
  };

  // Point the flush loop at a fresh, open leg and retire the previous one. On a
  // reconnect the previous leg is already dead so closeWs is a no-op; on a rotation
  // (or a rotation that fell back to reconnect while the old leg was live) it commits
  // and closes it. Always re-arm the rotation clock onto the new leg.
  const swapCurrentLeg = (ws: WebSocketLike): void => {
    const previous = currentWs;
    currentWs = ws;
    legStartedAt = Date.now();
    // Rotation fires no reconnect callback, so this is the only signal that clears a
    // lingering pre-swap partial caption.
    callbacks.onPartial?.('', '');
    flush();
    if (previous && previous !== ws) {
      closeWs(previous, { commit: true });
    }
    scheduleRotation();
  };

  const goTerminal = (error: unknown): void => {
    if (terminated) return;
    terminated = true;
    teardownCapture();
    closeWs(currentWs);
    currentWs = null;
    const message = error instanceof Error ? error.message : 'Realtime session ended';
    callbacks.onError?.({ error: { message } });
    notifyClose();
  };

  const handleCredentialChange = (): void => {
    goTerminal(new DOMException('Provider credential changed. Start a new session.', 'AbortError'));
  };

  // Replace a dead leg with a fresh one (bounded backoff), mic never stopping. Keeps
  // cumulativeOffsetMs unchanged: the new session's restarted clock rewinds this leg's
  // ms labels, but display order is by sortOrder (utterance index), not startMs.
  const attemptReconnect = (): void => {
    if (terminated || reconnecting || rotating) return;
    reconnecting = true;
    callbacks.onReconnecting?.();
    withRetry(
      async () => {
        // Bail once stopped so a stop() mid-backoff can't keep opening sockets / fetching
        // tokens; a 4xx-shaped status makes the strategy give up immediately.
        if (terminated) throw Object.assign(new Error('session stopped'), { status: 499 });
        const state = await Network.getNetworkStateAsync();
        // Status-less error → retryable, so the loop waits for connectivity to return.
        if (state.isConnected === false) throw new Error('offline');
        return openLeg();
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
        goTerminal(error); // budget exhausted / 4xx token — utterances still preserved
      });
  };

  const rollLeg = async (): Promise<void> => {
    if (terminated || reconnecting || rotating) return;
    rotating = true;
    // Advance the offset by the old leg's duration BEFORE opening the new leg so its
    // fresh-clock messages stamp continuously.
    cumulativeOffsetMs += Date.now() - legStartedAt;
    try {
      const newWs = await openLeg();
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
    const ws = currentWs;
    flush();
    closeWs(ws, { commit: true });
    currentWs = null;
    teardownCapture();
  };

  credentialScope.signal.addEventListener('abort', handleCredentialChange, { once: true });
  let firstProtocol: RealtimeProviderProtocol;
  try {
    firstProtocol = await prepareProtocol();
    credentialScope.assertActive();
  } catch (error) {
    credentialScope.dispose();
    credentialScope.signal.removeEventListener('abort', handleCredentialChange);
    throw error;
  }

  // Start capture before opening the socket so speech during connect is buffered and
  // flushed on open. If the mic fails, abort before any socket exists.
  frameSub = addPcmFrameListener((frame: PcmFrame) => {
    enqueuePcm(Buffer.from(frame.audio, 'base64'));
  });
  try {
    await LivePCMStreaming.start(sampleRate);
  } catch (error) {
    teardownCapture();
    throw error;
  }

  try {
    credentialScope.assertActive();
  } catch (error) {
    teardownCapture();
    throw error;
  }

  sessionStartedAt = Date.now();
  flushTimer = setInterval(flush, FLUSH_INTERVAL_MS);

  try {
    currentWs = await openLeg(firstProtocol);
  } catch (error) {
    teardownCapture();
    throw error;
  }

  try {
    credentialScope.assertActive();
  } catch (error) {
    closeWs(currentWs);
    teardownCapture();
    throw error;
  }

  legStartedAt = Date.now();
  flush(); // drain the cold-start buffer
  scheduleRotation();

  return { stop, utterances: reducer.utterances };
}

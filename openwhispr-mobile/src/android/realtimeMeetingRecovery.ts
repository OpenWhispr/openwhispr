import { applyLegOffset, namespaceItemId } from '@/services/transcription/realtimeReconnect';
import type {
  RealtimeTransportContext,
  RealtimeTransportLifecycle,
  WebSocketLike,
} from '@/services/transcription/createRealtimeMeetingWs';

const WS_OPEN = 1;
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

type CaptureEvents = {
  addPcmStopListener?: (callback: () => void) => { remove(): void } | null;
  addPcmErrorListener?: (
    callback: (event: { message: string }) => void,
  ) => { remove(): void } | null;
};

export function createAndroidRealtimeRecovery(
  context: RealtimeTransportContext,
  events: CaptureEvents,
): RealtimeTransportLifecycle {
  const {
    opts,
    callbacks,
    sampleRate,
    transport,
    capture,
    reducer,
    flush,
    closeWs,
    teardownCapture,
    goTerminal,
  } = context;
  const legMeta = new WeakMap<WebSocketLike, LegState>();
  const retiringLegs = new Map<WebSocketLike, Promise<void>>();
  const itemOrder = new Map<string, { leg: number; sequence: number }>();
  const orderedUtterances = () =>
    reducer.utterances().sort((a, b) => {
      const first = itemOrder.get(a.itemId)!;
      const second = itemOrder.get(b.itemId)!;
      return first.leg - second.leg || first.sequence - second.sequence;
    });

  let stopSub: { remove(): void } | null = null;
  let errorSub: { remove(): void } | null = null;
  let terminalError: Error | null = null;
  let finishing = false;
  let finishPromise: Promise<void> | null = null;
  let coverageIncomplete = false;
  const checkDrain = (meta: LegState) => {
    if (meta.drain?.acknowledged && meta.pendingItems.size === 0) meta.drain.complete();
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
    for (const ws of [transport.currentWs, ...retiringLegs.keys()]) {
      if (!ws) continue;
      legMeta.get(ws)?.drain?.fail(error);
      closeWs(ws);
    }
    transport.currentWs = null;
  };

  const handleMessage = (ws: WebSocketLike, event: { data: string }): void => {
    const meta = legMeta.get(ws);
    if (!meta || meta.closed || transport.terminated) return;
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

  const finish = (): Promise<void> => {
    if (finishPromise) return finishPromise;
    if (transport.terminated)
      return terminalError ? Promise.reject(terminalError) : Promise.resolve();
    finishing = true;
    if (transport.rotationTimer) clearTimeout(transport.rotationTimer);
    finishPromise = (async () => {
      try {
        await capture.stop();
        transport.frameSub?.remove();
        transport.frameSub = null;
        if (transport.flushTimer) clearInterval(transport.flushTimer);
        flush();
        const ws = transport.currentWs;
        const results = await Promise.allSettled([
          ...retiringLegs.values(),
          ws ? drainLeg(ws) : Promise.reject(new Error('Connection unavailable.')),
        ]);
        const failure = results.find((result) => result.status === 'rejected');
        if (failure?.status === 'rejected') throw failure.reason;
        if (coverageIncomplete)
          throw new Error('The connection was interrupted. The transcript may be incomplete.');
      } finally {
        transport.terminated = true;
        closeAllLegs(new Error('Meeting ended.'));
        teardownCapture();
      }
    })();
    return finishPromise;
  };

  const abort = () => {
    goTerminal(new Error('Meeting cancelled.'));
  };
  const assertNotAborted = () => {
    if (opts.signal?.aborted) throw new Error('Meeting cancelled.');
  };
  return {
    get finishing() {
      return finishing;
    },
    audioIncomplete() {
      coverageIncomplete = true;
    },
    markClosed(ws) {
      const meta = legMeta.get(ws);
      if (meta) meta.closed = true;
    },
    beforeFrameCleanup() {
      opts.signal?.removeEventListener('abort', abort);
    },
    afterFrameCleanup() {
      stopSub?.remove();
      stopSub = null;
      errorSub?.remove();
      errorSub = null;
    },
    handleMessage,
    registerLeg(ws, meta) {
      legMeta.set(
        ws,
        Object.assign(meta, {
          legacyProtocol: true,
          closed: false,
          pendingItems: new Set<string>(),
        }),
      );
    },
    retireLeg(previous) {
      const retiring = drainLeg(previous)
        .catch(() => {
          coverageIncomplete = true;
        })
        .finally(() => {
          closeWs(previous);
          retiringLegs.delete(previous);
        });
      retiringLegs.set(previous, retiring);
    },
    terminal(error) {
      terminalError = error instanceof Error ? error : new Error(String(error));
      transport.terminated = true;
      closeAllLegs(terminalError);
    },
    legClosed(ws) {
      const meta = legMeta.get(ws);
      if (transport.terminated || meta?.closed) return false;
      coverageIncomplete = true;
      meta?.drain?.fail(new Error('Connection closed before the final transcript.'));
      return true;
    },
    stop() {
      closeAllLegs(new Error('Meeting interrupted.'));
    },
    beforeToken: assertNotAborted,
    afterToken() {
      assertNotAborted();
      opts.signal?.addEventListener('abort', abort, { once: true });
    },
    async startCapture() {
      stopSub = events.addPcmStopListener?.(() => callbacks.onStopRequested?.()) ?? null;
      errorSub =
        events.addPcmErrorListener?.(({ message }) => goTerminal(new Error(message))) ?? null;
      await capture.start(sampleRate, opts.noteId, opts.signal);
      if (transport.terminated || opts.signal?.aborted) {
        await capture.stop();
        throw new Error('Meeting cancelled.');
      }
    },
    sessionMethods() {
      return { finish, utterances: orderedUtterances };
    },
  };
}

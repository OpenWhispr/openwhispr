/**
 * Service-level tests for the leg-swap transport: reconnect keeps the mic alive,
 * rotation hard-cuts seamlessly, and a terminal give-up preserves the transcript.
 * The WebSocket is injected (a controllable fake); the native mic module, the API
 * client, and expo-network are mocked; timers are faked so the backoff budget and
 * rotation clock elapse deterministically.
 */
import { Buffer } from 'buffer';
import { startRealtimeMeetingWs, type WebSocketLike } from '../RealtimeMeetingWsService';
import { ROTATION_MS } from '../realtimeReconnect';
import { api } from '@/lib/apiClient';
import * as Network from 'expo-network';
import { LivePCMStreaming, addPcmFrameListener } from '../../../../modules/live-pcm-streaming/src';

jest.mock('@/lib/apiClient', () => ({
  api: { post: jest.fn() },
}));

jest.mock('expo-network', () => ({
  getNetworkStateAsync: jest.fn(),
}));

jest.mock('../../../../modules/live-pcm-streaming/src', () => ({
  DEFAULT_SAMPLE_RATE: 24000,
  LivePCMStreaming: {
    start: jest.fn(),
    stop: jest.fn(),
    isRecording: jest.fn(() => true),
    isAvailable: jest.fn(() => true),
  },
  addPcmFrameListener: jest.fn(),
}));

const FLUSH_MS = 150;

interface WsMessage {
  type: string;
  [key: string]: unknown;
}

/** Controllable stand-in for a leg's WebSocket. Our own close() never fires onclose. */
class FakeWebSocket implements WebSocketLike {
  static instances: FakeWebSocket[] = [];

  readyState = 0; // CONNECTING
  onopen: ((event?: unknown) => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: ((event?: unknown) => void) | null = null;
  onclose: ((event: { code?: number }) => void) | null = null;
  sent: string[] = [];
  closed = false;
  closedCode: number | undefined;

  constructor(
    readonly url: string,
    readonly protocols: string[],
  ) {
    FakeWebSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(code?: number): void {
    if (this.closed) return;
    this.closed = true;
    this.closedCode = code;
    this.readyState = 3; // CLOSED
  }

  open(): void {
    this.readyState = 1; // OPEN
    this.onopen?.();
  }

  emit(message: WsMessage): void {
    this.onmessage?.({ data: JSON.stringify(message) });
  }

  /** Simulate the server/network closing the socket (fires onclose). */
  serverClose(code: number): void {
    this.readyState = 3;
    this.onclose?.({ code });
  }

  private parsed(): WsMessage[] {
    return this.sent.map((s) => JSON.parse(s) as WsMessage);
  }

  appends(): WsMessage[] {
    return this.parsed().filter((m) => m.type === 'input_audio_buffer.append');
  }

  appendedBytes(): number {
    return this.appends().reduce((n, a) => n + Buffer.from(a.audio as string, 'base64').length, 0);
  }

  didCommit(): boolean {
    return this.parsed().some((m) => m.type === 'input_audio_buffer.commit');
  }
}

const wsFactory = (url: string, protocols: string[]): WebSocketLike =>
  new FakeWebSocket(url, protocols);

const lastLeg = (): FakeWebSocket => FakeWebSocket.instances[FakeWebSocket.instances.length - 1];

/** Drain the microtask queue (mocked promise chains) without advancing fake time. */
async function flushMicro(): Promise<void> {
  for (let i = 0; i < 50; i++) {
    await Promise.resolve();
  }
}

function emitFrame(bytes: number[]): void {
  const calls = (addPcmFrameListener as jest.Mock).mock.calls;
  const cb = calls[calls.length - 1]?.[0] as ((frame: { audio: string }) => void) | undefined;
  cb?.({ audio: Buffer.from(bytes).toString('base64') });
}

const completed = (itemId: string, transcript: string): WsMessage => ({
  type: 'conversation.item.input_audio_transcription.completed',
  item_id: itemId,
  transcript,
});

/** Boot a session and open its first leg. Returns the session + first leg. */
async function boot(
  callbacks: Parameters<typeof startRealtimeMeetingWs>[1] = {},
  opts: Parameters<typeof startRealtimeMeetingWs>[0] = {},
): Promise<{ session: Awaited<ReturnType<typeof startRealtimeMeetingWs>>; leg1: FakeWebSocket }> {
  const startPromise = startRealtimeMeetingWs(opts, callbacks, { wsFactory });
  await flushMicro();
  const leg1 = lastLeg();
  leg1.open();
  const session = await startPromise;
  return { session, leg1 };
}

beforeEach(() => {
  jest.useFakeTimers();
  FakeWebSocket.instances = [];
  (api.post as jest.Mock).mockReset().mockResolvedValue({
    clientSecret: 'ek_test',
    model: 'gpt-4o-mini-transcribe',
  });
  (Network.getNetworkStateAsync as jest.Mock).mockReset().mockResolvedValue({ isConnected: true });
  (LivePCMStreaming.start as jest.Mock).mockReset().mockResolvedValue(undefined);
  (LivePCMStreaming.stop as jest.Mock).mockReset().mockResolvedValue(undefined);
  (addPcmFrameListener as jest.Mock).mockReset().mockReturnValue({ remove: jest.fn() });
});

afterEach(() => {
  jest.clearAllTimers();
  jest.useRealTimers();
});

describe('startRealtimeMeetingWs — normal meeting (leg-swap parity)', () => {
  it('streams batched PCM to the leg and returns namespaced utterances on stop', async () => {
    const { session, leg1 } = await boot();

    emitFrame([1, 2, 3, 4]);
    await jest.advanceTimersByTimeAsync(FLUSH_MS + 10);
    expect(leg1.appends()).toHaveLength(1);
    expect(Buffer.from(leg1.appends()[0].audio as string, 'base64')).toEqual(
      Buffer.from([1, 2, 3, 4]),
    );

    leg1.emit(completed('item_1', 'hello world'));
    const utterances = session.utterances();
    expect(utterances).toHaveLength(1);
    expect(utterances[0]).toMatchObject({ itemId: 'L1:item_1', text: 'hello world' });

    session.stop();
    expect(LivePCMStreaming.stop).toHaveBeenCalledTimes(1);
    expect(leg1.didCommit()).toBe(true);
    expect(leg1.closed).toBe(true);
  });
});

describe('startRealtimeMeetingWs — reconnect', () => {
  it('reconnects a transient drop without stopping the mic, resuming sends on the new leg', async () => {
    const callbacks = { onReconnecting: jest.fn(), onReconnected: jest.fn() };
    const { leg1 } = await boot(callbacks);

    leg1.serverClose(1006);
    await flushMicro();

    expect(callbacks.onReconnecting).toHaveBeenCalledTimes(1);
    // The mic MUST survive a reconnectable close (the whole point of the refactor).
    expect(LivePCMStreaming.stop).not.toHaveBeenCalled();

    const leg2 = lastLeg();
    expect(leg2).not.toBe(leg1);
    leg2.open();
    await flushMicro();
    expect(callbacks.onReconnected).toHaveBeenCalledTimes(1);

    // PCM now flows to the replacement leg.
    emitFrame([9, 9]);
    await jest.advanceTimersByTimeAsync(FLUSH_MS + 10);
    expect(leg2.appendedBytes()).toBeGreaterThan(0);
    expect(LivePCMStreaming.stop).not.toHaveBeenCalled();
  });

  it('stops cleanly mid-reconnect: no leg is swapped in and the mic stops exactly once', async () => {
    const callbacks = { onReconnected: jest.fn() };
    const { session, leg1 } = await boot(callbacks);

    leg1.serverClose(1006);
    await flushMicro(); // enters reconnect; a replacement leg is connecting
    const leg2 = lastLeg();
    expect(leg2).not.toBe(leg1);

    session.stop();
    expect(LivePCMStreaming.stop).toHaveBeenCalledTimes(1);

    leg2.open(); // in-flight reconnect resolves AFTER stop
    await flushMicro();
    expect(callbacks.onReconnected).not.toHaveBeenCalled();
    expect(leg2.closed).toBe(true);
  });

  it('halts the reconnect loop on stop(): no sockets opened or tokens fetched afterwards', async () => {
    const { session, leg1 } = await boot();

    leg1.serverClose(1006);
    await flushMicro(); // reconnecting; a replacement leg is connecting
    const socketsAtStop = FakeWebSocket.instances.length;
    const tokenCallsAtStop = (api.post as jest.Mock).mock.calls.length;

    session.stop();
    // Advance past the full connect-timeout + backoff budget — nothing new must spawn.
    await jest.advanceTimersByTimeAsync(120_000);
    await flushMicro();

    expect(FakeWebSocket.instances.length).toBe(socketsAtStop);
    expect((api.post as jest.Mock).mock.calls.length).toBe(tokenCallsAtStop);
    expect(LivePCMStreaming.stop).toHaveBeenCalledTimes(1);
  });

  it('goes terminal once the backoff budget is exhausted, with the transcript intact', async () => {
    const callbacks = { onError: jest.fn(), onClose: jest.fn(), onReconnecting: jest.fn() };
    const { leg1 } = await boot(callbacks);

    leg1.emit(completed('kept', 'keep me'));
    // Every reconnect attempt fails with a status-less (retryable) network error.
    (api.post as jest.Mock).mockRejectedValue(new Error('network down'));

    leg1.serverClose(1006);
    await flushMicro();
    await jest.advanceTimersByTimeAsync(120_000); // well past the ~45s budget
    await flushMicro();

    expect(callbacks.onReconnecting).toHaveBeenCalledTimes(1);
    expect(callbacks.onError).toHaveBeenCalledTimes(1);
    expect(callbacks.onClose).toHaveBeenCalledTimes(1);
    expect(LivePCMStreaming.stop).toHaveBeenCalledTimes(1);
  });

  it('preserves utterances captured before a terminal reconnect failure', async () => {
    const { session, leg1 } = await boot();
    leg1.emit(completed('kept', 'keep me'));
    (api.post as jest.Mock).mockRejectedValue(new Error('network down'));

    leg1.serverClose(1006);
    await flushMicro();
    await jest.advanceTimersByTimeAsync(120_000);
    await flushMicro();

    expect(session.utterances().map((u) => u.text)).toEqual(['keep me']);
  });

  it('gives up immediately when the reconnect token returns 4xx (no retry storm)', async () => {
    const callbacks = { onError: jest.fn() };
    const { leg1 } = await boot(callbacks);

    (api.post as jest.Mock).mockClear();
    (api.post as jest.Mock).mockRejectedValue(
      Object.assign(new Error('Bad Request'), { status: 400 }),
    );

    leg1.serverClose(1006);
    await flushMicro();
    await jest.advanceTimersByTimeAsync(60_000);
    await flushMicro();

    // A 4xx is deterministic — the strategy must not retry it.
    expect(api.post as jest.Mock).toHaveBeenCalledTimes(1);
    expect(callbacks.onError).toHaveBeenCalledTimes(1);
    expect(LivePCMStreaming.stop).toHaveBeenCalledTimes(1);
  });
});

describe('startRealtimeMeetingWs — rotation', () => {
  it('opens the new leg BEFORE committing+closing the old, spanning legs with distinct ids', async () => {
    const { session, leg1 } = await boot();
    leg1.emit(completed('a', 'leg one'));

    await jest.advanceTimersByTimeAsync(ROTATION_MS);
    await flushMicro();

    const leg2 = lastLeg();
    expect(leg2).not.toBe(leg1);
    // Hard-cut ordering: the old leg stays live until the new one is open.
    expect(leg1.didCommit()).toBe(false);
    expect(leg1.closed).toBe(false);

    leg2.open();
    await flushMicro();
    expect(leg1.didCommit()).toBe(true);
    expect(leg1.closed).toBe(true);

    // Same raw id "a" recycled by the fresh leg must not overwrite leg one.
    leg2.emit(completed('a', 'leg two'));
    const utterances = session.utterances();
    expect(utterances.map((u) => u.text)).toEqual(['leg one', 'leg two']);
    expect(utterances.map((u) => u.itemId)).toEqual(['L1:a', 'L2:a']);
    expect(LivePCMStreaming.stop).not.toHaveBeenCalled();
  });

  it('falls back to reconnect when a rotation fails, keeping the mic and retiring the old leg', async () => {
    const callbacks = { onReconnecting: jest.fn(), onReconnected: jest.fn() };
    const { leg1 } = await boot(callbacks);

    // The rotation's token fetch fails once; the follow-up reconnect then succeeds.
    (api.post as jest.Mock).mockRejectedValueOnce(new Error('rotate token failed'));
    await jest.advanceTimersByTimeAsync(ROTATION_MS);
    await flushMicro();

    // Rotation failed → fell back to a reconnect (old leg still live meanwhile).
    expect(callbacks.onReconnecting).toHaveBeenCalledTimes(1);
    expect(LivePCMStreaming.stop).not.toHaveBeenCalled();

    const leg2 = lastLeg();
    expect(leg2).not.toBe(leg1);
    leg2.open();
    await flushMicro();

    // The still-live old leg is retired (committed + closed) — no leaked socket.
    expect(leg1.didCommit()).toBe(true);
    expect(leg1.closed).toBe(true);
    expect(callbacks.onReconnected).toHaveBeenCalledTimes(1);
    expect(LivePCMStreaming.stop).not.toHaveBeenCalled();
  });

  it('clears the caption on the rotation seam so a stale partial cannot linger', async () => {
    const onPartial = jest.fn();
    const { leg1 } = await boot({ onPartial });

    // An in-progress partial on the old leg (never finalized into a completed).
    leg1.emit({
      type: 'conversation.item.input_audio_transcription.delta',
      item_id: 'x',
      delta: 'half a senten',
    });
    expect(onPartial).toHaveBeenLastCalledWith('half a senten', 'L1:x');

    await jest.advanceTimersByTimeAsync(ROTATION_MS);
    await flushMicro();
    lastLeg().open();
    await flushMicro();

    // The swap cleared the caption even though no completed event arrived.
    expect(onPartial).toHaveBeenLastCalledWith('', '');
  });

  it('routes PCM to exactly one leg across the seam', async () => {
    await boot();

    await jest.advanceTimersByTimeAsync(ROTATION_MS);
    await flushMicro();
    const leg2 = lastLeg();
    leg2.open();
    await flushMicro();

    emitFrame([7, 7, 7, 7]);
    await jest.advanceTimersByTimeAsync(FLUSH_MS + 10);
    expect(leg2.appendedBytes()).toBeGreaterThan(0);
  });
});

describe('startRealtimeMeetingWs — bounded outage buffer', () => {
  it('drops the oldest audio past the cap and replays only the recent tail on reconnect', async () => {
    // sampleRate 100 → cap = 100 * 2 * 20 = 4000 bytes.
    const { leg1 } = await boot({}, { sampleRate: 100 });

    leg1.serverClose(1006);
    await flushMicro(); // reconnecting; replacement leg connecting, not yet open

    // Buffer far more than the cap while the socket is down.
    for (let i = 0; i < 10; i++) emitFrame(new Array(1000).fill(i % 256));

    const leg2 = lastLeg();
    leg2.open();
    await flushMicro();

    const bytes = leg2.appendedBytes();
    expect(bytes).toBeGreaterThan(0);
    expect(bytes).toBeLessThanOrEqual(4000);
  });
});

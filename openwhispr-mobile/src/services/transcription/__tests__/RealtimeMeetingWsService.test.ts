/**
 * Service-level tests for the leg-swap transport: reconnect keeps the mic alive through
 * any outage, rotation hard-cuts seamlessly, a closing leg waits for its last turn, and a
 * terminal give-up preserves the transcript.
 * The WebSocket is injected (a controllable fake); the native mic module, the API
 * client, and expo-network are mocked; timers are faked so the backoff budget and
 * rotation clock elapse deterministically.
 */
import { Buffer } from 'buffer';
import { startRealtimeMeetingWs, type WebSocketLike } from '../RealtimeMeetingWsService';
import { ROTATION_MS, CONNECT_TIMEOUT_MS, STOP_FLUSH_TIMEOUT_MS } from '../realtimeReconnect';
import { acquireCaptureLease, releaseCaptureLease } from '@/lib/captureLease';
import { MEETING_RECORDING_DISABLED_MESSAGE } from '../policyErrors';
import { api } from '@/lib/apiClient';
import * as Network from 'expo-network';
import {
  LivePCMStreaming,
  addPcmFrameListener,
  addCaptureStateListener,
} from '../../../../modules/live-pcm-streaming/src';

jest.mock('@/lib/apiClient', () => ({
  api: { post: jest.fn() },
}));

jest.mock('@/lib/captureLease', () => ({
  acquireCaptureLease: jest.fn(),
  releaseCaptureLease: jest.fn(),
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
  addCaptureStateListener: jest.fn(),
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

/**
 * Advance fake time onto the rotation seam. advanceTimersByTimeAsync yields a real event-loop
 * turn after every timer it fires, and the flush interval fires 20,000 times before the seam, so
 * walking all of ROTATION_MS that way tied these tests' wall time to CPU load until they hit
 * Jest's timeout. The flush ticks queue no async work, so walk them synchronously and cross only
 * the seam itself (where the rotation's token fetch and leg open run) asynchronously.
 */
async function advanceToRotation(): Promise<void> {
  jest.advanceTimersByTime(ROTATION_MS - 1);
  await jest.advanceTimersByTimeAsync(1);
}

function emitFrame(bytes: number[]): void {
  const calls = (addPcmFrameListener as jest.Mock).mock.calls;
  const cb = calls[calls.length - 1]?.[0] as ((frame: { audio: string }) => void) | undefined;
  cb?.({ audio: Buffer.from(bytes).toString('base64') });
}

const committed = (itemId: string): WsMessage => ({
  type: 'input_audio_buffer.committed',
  item_id: itemId,
});

const commitEmpty: WsMessage = {
  type: 'error',
  error: { code: 'input_audio_buffer_commit_empty' },
};

/** Track whether a promise has settled without awaiting it. */
function track(promise: Promise<void>): { done: () => boolean } {
  let settled = false;
  void promise.then(() => {
    settled = true;
  });
  return { done: () => settled };
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
  (addCaptureStateListener as jest.Mock).mockReset().mockReturnValue({ remove: jest.fn() });
  (acquireCaptureLease as jest.Mock).mockReset().mockResolvedValue(undefined);
  (releaseCaptureLease as jest.Mock).mockReset();
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

    const stopped = session.stop();
    expect(LivePCMStreaming.stop).toHaveBeenCalledTimes(1);
    expect(leg1.didCommit()).toBe(true);
    leg1.emit(commitEmpty);
    await stopped;
    expect(leg1.closed).toBe(true);
  });
});

describe('startRealtimeMeetingWs — token purpose', () => {
  it('declares every mint, including a reconnect, as a meeting', async () => {
    const { leg1 } = await boot({}, { language: 'de' });
    leg1.serverClose(1006);
    await flushMicro();
    lastLeg().open();
    await flushMicro();

    const bodies = (api.post as jest.Mock).mock.calls.map(([, body]) => body);
    expect(bodies.length).toBeGreaterThanOrEqual(2);
    for (const body of bodies) {
      expect(body).toEqual({ purpose: 'meeting', streams: 1, language: 'de' });
    }
  });
});

describe('startRealtimeMeetingWs — org policy refusal', () => {
  const meetingRefusal = (): Error =>
    Object.assign(new Error('Meeting recording is turned off by your organization.'), {
      status: 403,
      code: 'POLICY_MEETING_RECORDING_DISABLED',
    });

  it('rejects the start with the mapped meeting message, before the mic or a socket opens', async () => {
    (api.post as jest.Mock).mockRejectedValue(meetingRefusal());

    await expect(startRealtimeMeetingWs({}, {}, { wsFactory })).rejects.toMatchObject({
      message: MEETING_RECORDING_DISABLED_MESSAGE,
      status: 403,
    });
    expect(LivePCMStreaming.start).not.toHaveBeenCalled();
    expect(FakeWebSocket.instances).toHaveLength(0);
  });

  it('ends a live meeting with the mapped message when the reconnect token is refused, without retrying', async () => {
    const callbacks = { onError: jest.fn() };
    const { leg1 } = await boot(callbacks);

    (api.post as jest.Mock).mockClear().mockRejectedValue(meetingRefusal());
    leg1.serverClose(1006);
    await flushMicro();
    await jest.advanceTimersByTimeAsync(60_000);
    await flushMicro();

    expect(api.post as jest.Mock).toHaveBeenCalledTimes(1);
    expect(callbacks.onError).toHaveBeenCalledWith({
      error: { message: MEETING_RECORDING_DISABLED_MESSAGE },
    });
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

    void session.stop();
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

    void session.stop();
    // Advance past the connect timeout and several backoff steps — nothing new must spawn.
    await jest.advanceTimersByTimeAsync(120_000);
    await flushMicro();

    expect(FakeWebSocket.instances.length).toBe(socketsAtStop);
    expect((api.post as jest.Mock).mock.calls.length).toBe(tokenCallsAtStop);
    expect(LivePCMStreaming.stop).toHaveBeenCalledTimes(1);
  });

  it('keeps the mic through an outage longer than the old budget', async () => {
    const callbacks = { onError: jest.fn(), onReconnecting: jest.fn(), onReconnected: jest.fn() };
    const { leg1 } = await boot(callbacks);
    (Network.getNetworkStateAsync as jest.Mock).mockResolvedValue({ isConnected: false });

    leg1.serverClose(1006);
    await flushMicro();
    // Backoff 1+2+4+8 s, then 15 s a step: 300 s covers well over 20 failed attempts.
    await jest.advanceTimersByTimeAsync(300_000);
    await flushMicro();

    // One sample for the close decision, then one per reconnect attempt.
    expect((Network.getNetworkStateAsync as jest.Mock).mock.calls.length).toBeGreaterThanOrEqual(
      21,
    );
    expect(LivePCMStreaming.stop).not.toHaveBeenCalled();
    expect(callbacks.onError).not.toHaveBeenCalled();
    expect(callbacks.onReconnecting).toHaveBeenCalledTimes(1);

    (Network.getNetworkStateAsync as jest.Mock).mockResolvedValue({ isConnected: true });
    await jest.advanceTimersByTimeAsync(15_000);
    await flushMicro();
    const leg2 = lastLeg();
    expect(leg2).not.toBe(leg1);
    leg2.open();
    await flushMicro();
    expect(callbacks.onReconnected).toHaveBeenCalledTimes(1);

    emitFrame([5, 5]);
    await jest.advanceTimersByTimeAsync(FLUSH_MS + 10);
    expect(leg2.appendedBytes()).toBeGreaterThan(0);
    expect(LivePCMStreaming.stop).not.toHaveBeenCalled();
  });

  it('preserves utterances captured before a terminal reconnect failure', async () => {
    const { session, leg1 } = await boot({ onError: jest.fn() });
    leg1.emit(completed('kept', 'keep me'));
    (api.post as jest.Mock).mockRejectedValue(
      Object.assign(new Error('Forbidden'), { status: 403 }),
    );

    leg1.serverClose(1006);
    await flushMicro();
    await jest.advanceTimersByTimeAsync(120_000);
    await flushMicro();

    expect(session.utterances().map((u) => u.text)).toEqual(['keep me']);
  });

  it('still ends the session when the token endpoint answers 4xx', async () => {
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

    await advanceToRotation();
    await flushMicro();

    const leg2 = lastLeg();
    expect(leg2).not.toBe(leg1);
    // Hard-cut ordering: the old leg stays live until the new one is open.
    expect(leg1.didCommit()).toBe(false);
    expect(leg1.closed).toBe(false);

    leg2.open();
    await flushMicro();
    expect(leg1.didCommit()).toBe(true);
    leg1.emit(commitEmpty); // nothing left to transcribe: the old leg closes
    await flushMicro();
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
    await advanceToRotation();
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
    await jest.advanceTimersByTimeAsync(STOP_FLUSH_TIMEOUT_MS);
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

    await advanceToRotation();
    await flushMicro();
    lastLeg().open();
    await flushMicro();

    // The swap cleared the caption even though no completed event arrived.
    expect(onPartial).toHaveBeenLastCalledWith('', '');
  });

  it('routes PCM to exactly one leg across the seam', async () => {
    await boot();

    await advanceToRotation();
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

describe('startRealtimeMeetingWs — capture lease', () => {
  it('acquires the lease before the mic starts', async () => {
    const order: string[] = [];
    (acquireCaptureLease as jest.Mock).mockImplementation(async () => {
      order.push('acquire');
    });
    (LivePCMStreaming.start as jest.Mock).mockImplementation(async () => {
      order.push('start');
    });

    await boot();

    expect(order).toEqual(['acquire', 'start']);
    expect(acquireCaptureLease).toHaveBeenCalledWith('meeting-cloud');
  });

  it('does not start the mic until the acquire has resolved', async () => {
    let grant: () => void = () => undefined;
    (acquireCaptureLease as jest.Mock).mockReturnValue(
      new Promise<void>((resolve) => {
        grant = resolve;
      }),
    );

    const startPromise = startRealtimeMeetingWs({}, {}, { wsFactory });
    await flushMicro();
    expect(LivePCMStreaming.start).not.toHaveBeenCalled();

    grant();
    await flushMicro();
    expect(LivePCMStreaming.start).toHaveBeenCalledTimes(1);
    lastLeg().open();
    await startPromise;
  });

  it('releases only after the mic has stopped', async () => {
    const { session } = await boot();
    let finishStop: () => void = () => undefined;
    (LivePCMStreaming.stop as jest.Mock).mockReturnValue(
      new Promise<void>((resolve) => {
        finishStop = resolve;
      }),
    );

    void session.stop();
    await flushMicro();
    expect(LivePCMStreaming.stop).toHaveBeenCalledTimes(1);
    expect(releaseCaptureLease).not.toHaveBeenCalled();

    finishStop();
    await flushMicro();
    expect(releaseCaptureLease).toHaveBeenCalledTimes(1);
    expect(releaseCaptureLease).toHaveBeenCalledWith('meeting-cloud');
  });

  it('still releases when the native stop rejects', async () => {
    const { session } = await boot();
    (LivePCMStreaming.stop as jest.Mock).mockRejectedValue(new Error('stop failed'));

    void session.stop();
    await flushMicro();

    expect(releaseCaptureLease).toHaveBeenCalledTimes(1);
  });

  it('releases when the mic fails to start', async () => {
    (LivePCMStreaming.start as jest.Mock).mockRejectedValue(new Error('mic busy'));

    await expect(startRealtimeMeetingWs({}, {}, { wsFactory })).rejects.toThrow('mic busy');

    expect(releaseCaptureLease).toHaveBeenCalledTimes(1);
    expect(releaseCaptureLease).toHaveBeenCalledWith('meeting-cloud');
  });

  it('releases when the first leg never opens', async () => {
    const startPromise = startRealtimeMeetingWs({}, {}, { wsFactory });
    const outcome = expect(startPromise).rejects.toThrow('connect timeout');
    await flushMicro();
    await jest.advanceTimersByTimeAsync(CONNECT_TIMEOUT_MS + 1);
    await outcome;
    await flushMicro();

    expect(LivePCMStreaming.stop).toHaveBeenCalledTimes(1);
    expect(releaseCaptureLease).toHaveBeenCalledTimes(1);
  });

  it('releases when the token is refused mid-meeting', async () => {
    const { leg1 } = await boot({ onError: jest.fn() });
    expect(releaseCaptureLease).not.toHaveBeenCalled();

    (api.post as jest.Mock).mockRejectedValue(
      Object.assign(new Error('Bad Request'), { status: 400 }),
    );
    leg1.serverClose(1006);
    await flushMicro();
    await jest.advanceTimersByTimeAsync(60_000);
    await flushMicro();

    expect(releaseCaptureLease).toHaveBeenCalledTimes(1);
  });

  it('releases once when stop is called twice', async () => {
    const { session } = await boot();

    void session.stop();
    void session.stop();
    await flushMicro();

    expect(releaseCaptureLease).toHaveBeenCalledTimes(1);
  });
});

describe('startRealtimeMeetingWs — stop finishes the last turn', () => {
  it('waits for the last turn before closing', async () => {
    const { session, leg1 } = await boot();

    const stopped = session.stop();
    const progress = track(stopped);
    expect(leg1.didCommit()).toBe(true);
    await flushMicro();
    expect(leg1.closed).toBe(false);

    leg1.emit(committed('A'));
    await jest.advanceTimersByTimeAsync(500);
    expect(progress.done()).toBe(false);
    leg1.emit(completed('A', 'last words'));
    await stopped;

    expect(session.utterances().map((u) => u.itemId)).toContain('L1:A');
    expect(leg1.closed).toBe(true);
  });

  it('resolves at once when the buffer was already empty', async () => {
    const { session, leg1 } = await boot();

    const progress = track(session.stop());
    leg1.emit(commitEmpty);
    await flushMicro();

    expect(progress.done()).toBe(true);
    expect(leg1.closed).toBe(true);
  });

  it('gives up waiting after 3 s', async () => {
    const { session, leg1 } = await boot();

    const progress = track(session.stop());
    await jest.advanceTimersByTimeAsync(STOP_FLUSH_TIMEOUT_MS - 1);
    expect(progress.done()).toBe(false);
    expect(leg1.closed).toBe(false);

    await jest.advanceTimersByTimeAsync(1);
    await flushMicro();
    expect(progress.done()).toBe(true);
    expect(leg1.closed).toBe(true);
  });

  it('does not wait when no socket is open', async () => {
    const { session, leg1 } = await boot();
    leg1.serverClose(1006);
    await flushMicro(); // reconnecting; the replacement leg is still connecting
    const leg2 = lastLeg();

    const progress = track(session.stop());
    await flushMicro();

    expect(progress.done()).toBe(true);
    expect(leg2.closed).toBe(true);
    expect(leg2.didCommit()).toBe(false);
  });

  it('stops the mic before waiting', async () => {
    const { session, leg1 } = await boot();
    const order: string[] = [];
    (LivePCMStreaming.stop as jest.Mock).mockImplementation(async () => {
      order.push('mic-stop');
    });
    const send = leg1.send.bind(leg1);
    leg1.send = (data: string): void => {
      if ((JSON.parse(data) as WsMessage).type === 'input_audio_buffer.commit') {
        order.push('commit');
      }
      send(data);
    };

    const progress = track(session.stop());

    expect(order).toEqual(['mic-stop', 'commit']);
    expect(progress.done()).toBe(false);
    leg1.emit(commitEmpty);
    await flushMicro();
    expect(progress.done()).toBe(true);
  });

  it('keeps a turn that completes on the old leg after a rotation', async () => {
    const { session, leg1 } = await boot();
    leg1.emit(committed('B')); // the server's VAD closed a turn; it is mid-transcription

    await advanceToRotation();
    await flushMicro();
    const leg2 = lastLeg();
    leg2.open();
    await flushMicro();

    // Our commit found nothing new, but turn B is still being transcribed.
    leg1.emit(commitEmpty);
    await flushMicro();
    expect(leg1.closed).toBe(false);

    await jest.advanceTimersByTimeAsync(500);
    leg1.emit(completed('B', 'old leg turn'));
    await flushMicro();

    expect(session.utterances().map((u) => u.itemId)).toContain('L1:B');
    expect(leg1.closed).toBe(true);
    expect(leg2.closed).toBe(false);
  });

  it('forwards capture-state events', async () => {
    const onCaptureState = jest.fn();
    const remove = jest.fn();
    (addCaptureStateListener as jest.Mock).mockReturnValue({ remove });
    const { session, leg1 } = await boot({ onCaptureState });

    const calls = (addCaptureStateListener as jest.Mock).mock.calls;
    const listener = calls[calls.length - 1][0] as (event: {
      state: 'capturing' | 'interrupted';
      reason: string;
      capturedMs: number;
    }) => void;
    listener({ state: 'interrupted', reason: 'interruption', capturedMs: 1000 });
    expect(onCaptureState).toHaveBeenLastCalledWith({ capturing: false, reason: 'interruption' });
    listener({ state: 'capturing', reason: 'interruptionEnded', capturedMs: 1000 });
    expect(onCaptureState).toHaveBeenLastCalledWith({
      capturing: true,
      reason: 'interruptionEnded',
    });

    const stopped = session.stop();
    expect(remove).toHaveBeenCalledTimes(1);
    leg1.emit(commitEmpty);
    await stopped;
  });

  it('counts captured and dropped audio', async () => {
    // sampleRate 100 → 200 bytes a second; the outage buffer holds 4000 bytes.
    const { session, leg1 } = await boot({}, { sampleRate: 100 });

    emitFrame(new Array(200).fill(1));
    await jest.advanceTimersByTimeAsync(FLUSH_MS + 10);
    expect(session.capturedMs()).toBe(1000);
    expect(session.droppedMs()).toBe(0);

    leg1.serverClose(1006);
    await flushMicro(); // the replacement leg is connecting, not open
    for (let i = 0; i < 10; i++) emitFrame(new Array(1000).fill(2));

    expect(session.capturedMs()).toBe(51_000);
    expect(session.droppedMs()).toBe(30_000); // six 1000-byte frames fell off the front
  });
});

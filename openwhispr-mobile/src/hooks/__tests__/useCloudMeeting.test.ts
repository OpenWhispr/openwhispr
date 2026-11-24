import { act, renderHook, type RenderHookResult } from '@testing-library/react-native';
import { useCloudMeeting, type CloudMeeting } from '@/hooks/useCloudMeeting';
import type {
  RealtimeCallbacks,
  RealtimeSession,
  RealtimeUtterance,
} from '@/services/transcription/RealtimeMeetingWsService';
import { reportCaptureInterrupted } from '@/lib/meetingCaptureTelemetry';
import type { CloudMeetingResult } from '@/hooks/useCloudMeeting';

const mockStart = jest.fn();

jest.mock('@/services/transcription/RealtimeMeetingWsService', () => ({
  startRealtimeMeetingWs: (...args: unknown[]) => mockStart(...args),
}));

const mockFailedListeners: Array<() => void> = [];
const mockRemove = jest.fn();

jest.mock('../../../modules/live-pcm-streaming/src', () => ({
  addRecordingFailedListener: (callback: () => void) => {
    mockFailedListeners.push(callback);
    return { remove: mockRemove };
  },
}));

jest.mock('@/lib/meetingCaptureTelemetry', () => ({
  reportCaptureInterrupted: jest.fn(),
  reportSessionEnded: jest.fn(),
}));

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => undefined;
  let reject: (error: unknown) => void = () => undefined;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** A controllable stand-in for one realtime session and the callbacks it was started with. */
interface FakeSession {
  session: RealtimeSession & { stop: jest.Mock };
  callbacks: RealtimeCallbacks;
  start: Deferred<RealtimeSession>;
  drain: Deferred<void>;
  delivered: RealtimeUtterance[];
  setCapturedMs: (ms: number) => void;
  /** Delivers an utterance the way the reducer would: it is in the list before the callback. */
  deliver: (text: string) => void;
}

let sessions: FakeSession[] = [];

function utterance(text: string): RealtimeUtterance {
  return { itemId: `item-${text}`, text, startMs: null, endMs: null };
}

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(1_000_000);
  sessions = [];
  mockFailedListeners.length = 0;
  mockRemove.mockClear();
  (reportCaptureInterrupted as jest.Mock).mockClear();
  mockStart.mockReset().mockImplementation((_opts: unknown, callbacks: RealtimeCallbacks) => {
    const start = deferred<RealtimeSession>();
    const drain = deferred<void>();
    const delivered: RealtimeUtterance[] = [];
    let capturedMs = 0;
    const session = {
      stop: jest.fn(() => drain.promise),
      utterances: () => [...delivered],
      capturedMs: () => capturedMs,
      droppedMs: () => 0,
      droppedWindows: () => [],
    };
    sessions.push({
      session,
      callbacks,
      start,
      drain,
      delivered,
      setCapturedMs: (ms) => {
        capturedMs = ms;
      },
      deliver: (text) => {
        const next = utterance(text);
        delivered.push(next);
        callbacks.onUtterance?.(next);
      },
    });
    return start.promise;
  });
});

afterEach(() => {
  jest.clearAllTimers();
  jest.useRealTimers();
});

type Props = { enabled: boolean };
type Setup = RenderHookResult<CloudMeeting, Props> & {
  onUtterance: jest.Mock;
  setEnabled: (enabled: boolean) => void;
};

function setup(enabled = true, recordingUri?: string): Setup {
  const onUtterance = jest.fn();
  const hook = renderHook(
    (p: Props) => useCloudMeeting({ enabled: p.enabled, onUtterance, recordingUri }),
    {
      initialProps: { enabled },
    },
  );
  return {
    ...hook,
    onUtterance,
    setEnabled: (next) => hook.rerender({ enabled: next }),
  };
}

const latest = (): FakeSession => sessions[sessions.length - 1];

async function goLive(fake: FakeSession = latest()): Promise<void> {
  await act(async () => {
    fake.start.resolve(fake.session);
    await Promise.resolve();
  });
}

function tick(ms: number): void {
  act(() => {
    jest.advanceTimersByTime(ms);
  });
}

describe('useCloudMeeting', () => {
  it('starts a second session in the same mount from fresh state', async () => {
    const { result, onUtterance, setEnabled } = setup();
    const first = latest();
    await goLive(first);
    first.setCapturedMs(12_000);
    act(() => {
      first.deliver('one');
      first.deliver('two');
      first.callbacks.onReconnecting?.();
      first.callbacks.onCaptureState?.({ capturing: false, reason: 'interruption' });
    });
    tick(1_000);
    expect(result.current).toMatchObject({
      status: 'interrupted',
      reconnects: 1,
      interruptions: 1,
      capturedSeconds: 12,
    });
    expect(result.current.utterances).toHaveLength(2);

    let stopped: Promise<CloudMeetingResult> = Promise.resolve({
      utterances: [],
      droppedWindows: [],
      recordingUri: null,
    });
    act(() => {
      stopped = result.current.stop();
    });
    await act(async () => {
      first.drain.resolve();
      await stopped;
    });
    setEnabled(false);
    setEnabled(true);

    const second = latest();
    expect(second).not.toBe(first);
    expect(result.current).toMatchObject({
      status: 'connecting',
      error: null,
      partialText: '',
      utterances: [],
      capturedSeconds: 0,
      droppedSeconds: 0,
      interruptions: 0,
      reconnects: 0,
      liveSinceMs: null,
    });

    await goLive(second);
    tick(1_000);
    expect(result.current.status).toBe('live');
    expect(result.current.interruptions).toBe(0);

    onUtterance.mockClear();
    act(() => {
      second.deliver('fresh');
    });
    expect(onUtterance).toHaveBeenCalledWith(utterance('fresh'), 0, 0);
    expect(result.current.utterances.map((u) => u.text)).toEqual(['fresh']);
  });

  it('resolves Stop while connecting with nothing and stops the session once it starts', async () => {
    const { result } = setup();
    const fake = latest();

    let stopResult: CloudMeetingResult | null = null;
    await act(async () => {
      stopResult = await result.current.stop();
    });
    expect(stopResult).toEqual({ utterances: [], droppedWindows: [], recordingUri: null });

    await goLive(fake);
    expect(fake.session.stop).toHaveBeenCalledTimes(1);
    expect(result.current.liveSinceMs).toBeNull();
  });

  it('waits for the drain and returns every utterance, including one delivered meanwhile', async () => {
    const { result, onUtterance } = setup();
    const fake = latest();
    await goLive(fake);
    act(() => {
      fake.deliver('before stop');
    });

    let settled = false;
    let stopped: Promise<CloudMeetingResult> = Promise.resolve({
      utterances: [],
      droppedWindows: [],
      recordingUri: null,
    });
    act(() => {
      stopped = result.current.stop();
      void stopped.then(() => {
        settled = true;
      });
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(fake.session.stop).toHaveBeenCalledTimes(1);
    expect(settled).toBe(false);

    act(() => {
      fake.deliver('last words');
    });
    expect(onUtterance).toHaveBeenLastCalledWith(utterance('last words'), 1, 0);

    let final: RealtimeUtterance[] = [];
    await act(async () => {
      fake.drain.resolve();
      final = (await stopped).utterances;
    });
    expect(final.map((u) => u.text)).toEqual(['before stop', 'last words']);
  });

  it('keeps the status on a non-fatal error and ends it on a close it did not start', async () => {
    const { result } = setup();
    const fake = latest();
    await goLive(fake);

    act(() => {
      fake.callbacks.onError?.({ error: { message: 'rate limited for a moment' } });
    });
    expect(result.current.status).toBe('live');
    expect(result.current.error).toBe('rate limited for a moment');

    act(() => {
      fake.callbacks.onClose?.();
    });
    expect(result.current.status).toBe('error');
  });

  it('counts one interruption when the native event and the stall check both see it', async () => {
    const { result } = setup();
    const fake = latest();
    await goLive(fake);
    fake.setCapturedMs(1_000);
    tick(1_000);

    act(() => {
      fake.callbacks.onCaptureState?.({ capturing: false, reason: 'interruption' });
    });
    // No audio grows for well past the stall window while the mic is down.
    tick(10_000);
    expect(result.current.interruptions).toBe(1);

    act(() => {
      fake.callbacks.onCaptureState?.({ capturing: true, reason: 'interruptionEnded' });
    });
    fake.setCapturedMs(2_000);
    tick(1_000);
    expect(result.current.status).toBe('live');
    expect(result.current.interruptions).toBe(1);

    act(() => {
      fake.callbacks.onCaptureState?.({ capturing: false, reason: 'interruption' });
    });
    expect(result.current.interruptions).toBe(2);
    expect(reportCaptureInterrupted).toHaveBeenCalledTimes(2);
  });

  it('reports when the session went live, not when it was asked to start', async () => {
    const { result } = setup();
    expect(result.current.liveSinceMs).toBeNull();

    // A slow first-run permission prompt and connect.
    act(() => {
      jest.advanceTimersByTime(45_000);
    });
    expect(result.current.liveSinceMs).toBeNull();
    await goLive();
    expect(result.current.liveSinceMs).toBe(1_045_000);
  });

  it('returns the recording and the dropped windows at stop, read after the stop settled', async () => {
    const { result } = setup(true, 'file:///docs/meeting-7.wav');
    const fake = latest();
    expect(mockStart.mock.calls[0][0]).toMatchObject({
      recordingUri: 'file:///docs/meeting-7.wav',
    });
    await goLive(fake);
    const windows = [{ startMs: 1_000, endMs: 2_000 }];
    const droppedWindows = fake.session as { droppedWindows: () => typeof windows };
    droppedWindows.droppedWindows = () => []; // nothing yet: the stop adds the window
    let stopped: Promise<CloudMeetingResult> = Promise.resolve({
      utterances: [],
      droppedWindows: [],
      recordingUri: null,
    });
    act(() => {
      stopped = result.current.stop();
    });
    droppedWindows.droppedWindows = () => windows;
    let value: CloudMeetingResult | null = null;
    await act(async () => {
      fake.drain.resolve();
      value = await stopped;
    });
    expect(value).toEqual({
      utterances: [],
      droppedWindows: windows,
      recordingUri: 'file:///docs/meeting-7.wav',
    });
  });

  it('returns no recording after a recording-failed event, and not for a later session', async () => {
    const { result, setEnabled } = setup(true, 'file:///docs/meeting-7.wav');
    const first = latest();
    expect(mockFailedListeners).toHaveLength(1);
    await goLive(first);
    act(() => {
      mockFailedListeners[0]();
    });
    let stopped: Promise<CloudMeetingResult> = Promise.resolve({
      utterances: [],
      droppedWindows: [],
      recordingUri: 'x',
    });
    act(() => {
      stopped = result.current.stop();
    });
    let value: CloudMeetingResult | null = null;
    await act(async () => {
      first.drain.resolve();
      value = await stopped;
    });
    expect((value as unknown as CloudMeetingResult).recordingUri).toBeNull();

    setEnabled(false);
    expect(mockRemove).toHaveBeenCalled();
    setEnabled(true);
    const second = latest();
    await goLive(second);
    // A late event from the first session's listener must not mark the second.
    act(() => {
      mockFailedListeners[0]();
    });
    act(() => {
      stopped = result.current.stop();
    });
    await act(async () => {
      second.drain.resolve();
      value = await stopped;
    });
    expect((value as unknown as CloudMeetingResult).recordingUri).toBe(
      'file:///docs/meeting-7.wav',
    );
  });

  it('returns no recording when none was requested', async () => {
    const { result } = setup();
    await goLive();
    let stopped: Promise<CloudMeetingResult> = Promise.resolve({
      utterances: [],
      droppedWindows: [],
      recordingUri: 'x',
    });
    act(() => {
      stopped = result.current.stop();
    });
    let value: CloudMeetingResult | null = null;
    await act(async () => {
      latest().drain.resolve();
      value = await stopped;
    });
    expect((value as unknown as CloudMeetingResult).recordingUri).toBeNull();
  });
});

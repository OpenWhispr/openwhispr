import { act, renderHook } from '@testing-library/react-native';
import {
  useMeetingRecorderHealth,
  type HealthRecorder,
  type RecorderHealth,
} from '../useMeetingRecorderHealth';

type ExpoState = 'recording' | 'paused' | 'stopped';

// Models expo-audio on iOS: `state` is expo's bookkeeping (what getStatus() reports), `native`
// is the AVAudioRecorder (what the isRecording property reports).
type FakeRecorder = HealthRecorder & {
  getStatus: jest.Mock;
  record: jest.Mock;
  pause: jest.Mock;
  state: ExpoState;
  native: boolean;
  // A phone call holds the microphone, so the native recorder refuses to record.
  micHeld: boolean;
  nativeReads: number;
  // `expoNotices` false is iOS pausing the recorder before expo's interruption handler looks.
  startCall(options?: { expoNotices?: boolean }): void;
  // `shouldResume` is iOS asking apps to resume, which runs expo's own resume.
  endCall(options?: { shouldResume?: boolean }): void;
};

function fakeRecorder(recording: boolean): FakeRecorder {
  // AudioRecorder.startRecording: nothing unless paused, and the native result is ignored, so a
  // refused record still reads as recording.
  const startRecording = (): void => {
    if (recorder.state !== 'paused') return;
    if (!recorder.micHeld) recorder.native = true;
    recorder.state = 'recording';
  };
  // AudioRecorder.pauseRecording: only from its own recording state.
  const pauseRecording = (): void => {
    if (recorder.state !== 'recording') return;
    recorder.native = false;
    recorder.state = 'paused';
  };
  const recorder: FakeRecorder = {
    state: recording ? 'recording' : 'paused',
    native: recording,
    micHeld: false,
    nativeReads: 0,
    get isRecording(): boolean {
      recorder.nativeReads += 1;
      return recorder.native;
    },
    getStatus: jest.fn(() => ({ isRecording: recorder.state === 'recording' })),
    record: jest.fn(startRecording),
    pause: jest.fn(pauseRecording),
    startCall: ({ expoNotices = true } = {}) => {
      recorder.micHeld = true;
      if (expoNotices) pauseRecording();
      recorder.native = false;
    },
    endCall: ({ shouldResume = true } = {}) => {
      recorder.micHeld = false;
      if (shouldResume && !recorder.native) startRecording();
    },
  };
  return recorder;
}

function tick(ms: number): void {
  act(() => {
    jest.advanceTimersByTime(ms);
  });
}

describe('useMeetingRecorderHealth', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it('counts captured time while the recorder records', () => {
    const recorder = fakeRecorder(true);
    const { result } = renderHook(() => useMeetingRecorderHealth(recorder, true, () => true));

    tick(4000);

    expect(result.current).toEqual({ capturing: true, capturedMs: 4000 });
    expect(recorder.record).not.toHaveBeenCalled();
    expect(recorder.pause).not.toHaveBeenCalled();
  });

  it('reports not capturing and asks the recorder to resume', () => {
    const recorder = fakeRecorder(false);
    recorder.micHeld = true;
    const { result } = renderHook(() => useMeetingRecorderHealth(recorder, true, () => true));

    tick(1000);

    expect(result.current).toEqual({ capturing: false, capturedMs: 0 });
    expect(recorder.record).toHaveBeenCalledTimes(1);
  });

  it('retries the resume no more often than every 2 s', () => {
    const recorder = fakeRecorder(false);
    recorder.micHeld = true;
    renderHook(() => useMeetingRecorderHealth(recorder, true, () => true));

    tick(5000);

    expect(recorder.record).toHaveBeenCalledTimes(3);
  });

  it('resumes once a call expo paused the recorder for has ended', () => {
    const recorder = fakeRecorder(true);
    const { result } = renderHook(() => useMeetingRecorderHealth(recorder, true, () => true));
    tick(2000);

    recorder.startCall();
    tick(5000);
    expect(result.current.capturing).toBe(false);
    expect(recorder.record).toHaveBeenCalled();

    // Without expo's own resume: the next attempt resumes it and the poll after confirms it.
    recorder.endCall({ shouldResume: false });
    tick(3000);

    expect(result.current.capturing).toBe(true);
    expect(recorder.getStatus().isRecording).toBe(true);
  });

  it("leaves expo's own resume working after a resume refused during a call", () => {
    const recorder = fakeRecorder(true);
    const { result } = renderHook(() => useMeetingRecorderHealth(recorder, true, () => true));
    recorder.startCall();
    tick(1000);
    const attempts = recorder.record.mock.calls.length;
    expect(attempts).toBeGreaterThan(0);

    recorder.endCall();
    tick(1000);

    expect(result.current.capturing).toBe(true);
    expect(recorder.record).toHaveBeenCalledTimes(attempts);
  });

  it('notices a recorder iOS paused without telling expo, and resumes it', () => {
    const recorder = fakeRecorder(true);
    const { result } = renderHook(() => useMeetingRecorderHealth(recorder, true, () => true));
    tick(2000);

    // expo still reads recording, so its own resume when the interruption ends does nothing.
    recorder.startCall({ expoNotices: false });
    recorder.endCall();
    expect(recorder.getStatus().isRecording).toBe(true);
    tick(1000);
    expect(result.current.capturing).toBe(false);

    tick(1000);

    expect(result.current.capturing).toBe(true);
    expect(recorder.record).toHaveBeenCalledTimes(1);
  });

  it('does not count captured time while the recorder is stopped', () => {
    const recorder = fakeRecorder(true);
    const { result } = renderHook(() => useMeetingRecorderHealth(recorder, true, () => true));
    tick(3000);

    recorder.startCall();
    tick(10_000);
    expect(result.current).toEqual({ capturing: false, capturedMs: 3000 });

    recorder.endCall();
    tick(2000);

    expect(result.current).toEqual({ capturing: true, capturedMs: 4000 });
  });

  it('does not resume while shouldResume is false', () => {
    const recorder = fakeRecorder(true);
    const { result } = renderHook(() => useMeetingRecorderHealth(recorder, true, () => false));
    recorder.startCall({ expoNotices: false });
    recorder.endCall();

    tick(5000);

    expect(result.current).toEqual({ capturing: false, capturedMs: 0 });
    expect(recorder.record).not.toHaveBeenCalled();
    expect(recorder.pause).not.toHaveBeenCalled();
  });

  it('resumes once shouldResume turns true', () => {
    const recorder = fakeRecorder(false);
    let allowed = false;
    renderHook(() => useMeetingRecorderHealth(recorder, true, () => allowed));
    tick(3000);
    expect(recorder.record).not.toHaveBeenCalled();

    allowed = true;
    tick(1000);

    expect(recorder.record).toHaveBeenCalledTimes(1);
  });

  it('survives record() throwing', () => {
    const recorder = fakeRecorder(false);
    recorder.record.mockImplementation(() => {
      throw new Error('session busy');
    });
    const { result } = renderHook(() => useMeetingRecorderHealth(recorder, true, () => true));

    tick(5000);

    expect(result.current.capturing).toBe(false);
    expect(recorder.record).toHaveBeenCalledTimes(3);
  });

  it('does nothing while inactive', () => {
    const recorder = fakeRecorder(false);
    const { result } = renderHook(() => useMeetingRecorderHealth(recorder, false, () => true));

    tick(5000);

    expect(recorder.nativeReads).toBe(0);
    expect(recorder.getStatus).not.toHaveBeenCalled();
    expect(recorder.record).not.toHaveBeenCalled();
    expect(result.current).toEqual({ capturing: false, capturedMs: 0 });
  });

  it('does nothing without a recorder', () => {
    const { result } = renderHook(() => useMeetingRecorderHealth(null, true, () => true));

    tick(5000);

    expect(result.current).toEqual({ capturing: false, capturedMs: 0 });
  });

  it('stops polling when it goes inactive', () => {
    const recorder = fakeRecorder(false);
    recorder.micHeld = true;
    const { rerender } = renderHook(
      ({ active }: { active: boolean }) => useMeetingRecorderHealth(recorder, active, () => true),
      { initialProps: { active: true } },
    );
    tick(1000);
    const calls = recorder.record.mock.calls.length;

    rerender({ active: false });
    tick(5000);

    expect(recorder.record).toHaveBeenCalledTimes(calls);
  });

  it('starts each active period as capturing with a zero clock', () => {
    const first = fakeRecorder(true);
    const second = fakeRecorder(true);
    const renders: RecorderHealth[] = [];
    const { rerender } = renderHook(
      ({ recorder, active }: { recorder: FakeRecorder; active: boolean }) => {
        const health = useMeetingRecorderHealth(recorder, active, () => false);
        renders.push(health);
        return health;
      },
      { initialProps: { recorder: first, active: true } },
    );
    expect(renders[0]).toEqual({ capturing: true, capturedMs: 0 });
    tick(3000);
    first.startCall();
    tick(1000);
    rerender({ recorder: first, active: false });
    expect(renders.at(-1)).toEqual({ capturing: false, capturedMs: 3000 });

    const firstNewRender = renders.length;
    rerender({ recorder: second, active: true });
    tick(1000);

    expect(renders[firstNewRender]).toEqual({ capturing: true, capturedMs: 0 });
    expect(renders.at(-1)).toEqual({ capturing: true, capturedMs: 1000 });
  });

  it('keeps the last values after it becomes inactive', () => {
    const recorder = fakeRecorder(true);
    const { result, rerender } = renderHook(
      ({ active }: { active: boolean }) => useMeetingRecorderHealth(recorder, active, () => false),
      { initialProps: { active: true } },
    );
    tick(2000);

    rerender({ active: false });
    tick(5000);

    expect(result.current).toEqual({ capturing: true, capturedMs: 2000 });
  });

  it('stops polling on unmount', () => {
    const recorder = fakeRecorder(false);
    recorder.micHeld = true;
    const { unmount } = renderHook(() => useMeetingRecorderHealth(recorder, true, () => true));
    tick(1000);
    const reads = recorder.nativeReads;
    const calls = recorder.record.mock.calls.length;

    unmount();
    tick(5000);

    expect(recorder.nativeReads).toBe(reads);
    expect(recorder.record).toHaveBeenCalledTimes(calls);
  });

  it('does not count a call the app slept through as captured', () => {
    const recorder = fakeRecorder(true);
    const { result } = renderHook(() => useMeetingRecorderHealth(recorder, true, () => true));
    tick(2000);

    // Suspended for a minute: expo paused and resumed the recorder, and no poll ran meanwhile.
    jest.setSystemTime(Date.now() + 60_000);
    tick(1000);

    expect(result.current).toEqual({ capturing: true, capturedMs: 4000 });
  });

  it('leaves alone a recorder whose record() did nothing', () => {
    // Android's record() does nothing on an unprepared recorder; pausing it would block its
    // next prepare.
    const recorder = fakeRecorder(false);
    recorder.state = 'stopped';
    renderHook(() => useMeetingRecorderHealth(recorder, true, () => true));

    tick(1000);

    expect(recorder.record).toHaveBeenCalledTimes(1);
    expect(recorder.pause).not.toHaveBeenCalled();
  });
});

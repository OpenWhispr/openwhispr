import { act, renderHook } from '@testing-library/react-native';
import { useMeetingRecorderHealth, type HealthRecorder } from '../useMeetingRecorderHealth';

type FakeRecorder = HealthRecorder & {
  getStatus: jest.Mock;
  record: jest.Mock;
};

function fakeRecorder(isRecording: boolean, durationMillis = 0): FakeRecorder {
  return {
    getStatus: jest.fn(() => ({ isRecording, durationMillis })),
    record: jest.fn(),
  };
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

  it('reports the recorder clock while recording', () => {
    const recorder = fakeRecorder(true, 4200);
    const { result } = renderHook(() => useMeetingRecorderHealth(recorder, true, () => true));

    tick(1000);

    expect(result.current).toEqual({ capturing: true, capturedMs: 4200 });
    expect(recorder.record).not.toHaveBeenCalled();
  });

  it('reports not capturing and asks the recorder to resume', () => {
    const recorder = fakeRecorder(false, 3000);
    const { result } = renderHook(() => useMeetingRecorderHealth(recorder, true, () => true));

    tick(1000);

    expect(result.current).toEqual({ capturing: false, capturedMs: 3000 });
    expect(recorder.record).toHaveBeenCalledTimes(1);
  });

  it('retries the resume no more often than every 2 s', () => {
    const recorder = fakeRecorder(false);
    renderHook(() => useMeetingRecorderHealth(recorder, true, () => true));

    tick(5000);

    expect(recorder.record).toHaveBeenCalledTimes(3);
  });

  it('does not resume while shouldResume is false', () => {
    const recorder = fakeRecorder(false, 3000);
    const { result } = renderHook(() => useMeetingRecorderHealth(recorder, true, () => false));

    tick(5000);

    expect(result.current).toEqual({ capturing: false, capturedMs: 3000 });
    expect(recorder.record).not.toHaveBeenCalled();
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

  it('stops polling on unmount', () => {
    const recorder = fakeRecorder(false);
    const { unmount } = renderHook(() => useMeetingRecorderHealth(recorder, true, () => true));
    tick(1000);
    const polls = recorder.getStatus.mock.calls.length;
    const calls = recorder.record.mock.calls.length;

    unmount();
    tick(5000);

    expect(recorder.getStatus).toHaveBeenCalledTimes(polls);
    expect(recorder.record).toHaveBeenCalledTimes(calls);
  });
});

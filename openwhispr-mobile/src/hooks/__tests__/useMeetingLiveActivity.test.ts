import { renderHook, type RenderHookResult } from '@testing-library/react-native';
import { useMeetingLiveActivity, type MeetingActivityPhase } from '@/hooks/useMeetingLiveActivity';

const mockStartMeeting = jest.fn();
const mockSetMeetingProcessing = jest.fn();
const mockSetMeetingCapture = jest.fn();
const mockEndMeeting = jest.fn();
const mockRemove = jest.fn();
let mockEndListener: (() => void) | undefined;

jest.mock('../../../modules/live-activity/src', () => ({
  LiveActivity: {
    startMeeting: (input: unknown) => mockStartMeeting(input),
    setMeetingProcessing: (input: unknown) => mockSetMeetingProcessing(input),
    setMeetingCapture: (input: unknown) => mockSetMeetingCapture(input),
    endMeeting: () => mockEndMeeting(),
    addEndMeetingListener: (listener: () => void) => {
      mockEndListener = listener;
      return { remove: mockRemove };
    },
  },
}));

type Props = {
  phase: MeetingActivityPhase;
  title: string | null;
  startedAt: number | null;
  capturing: boolean;
  capturedSeconds: number;
  onEndRequested: () => void;
};

type Setup = RenderHookResult<void, Props> & {
  onEndRequested: jest.Mock;
  update: (next: Partial<Props>) => void;
};

function setup(initial: Partial<Props> = {}): Setup {
  const onEndRequested = jest.fn();
  const props: Props = {
    phase: 'idle',
    title: null,
    startedAt: null,
    capturing: true,
    capturedSeconds: 0,
    onEndRequested,
    ...initial,
  };
  const hook = renderHook((p: Props) => useMeetingLiveActivity(p), { initialProps: props });
  return {
    ...hook,
    onEndRequested,
    update: (next: Partial<Props>) => hook.rerender({ ...props, ...next }),
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockEndListener = undefined;
  jest.spyOn(Date, 'now').mockReturnValue(1_000_000);
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('useMeetingLiveActivity', () => {
  it('starts the meeting card when recording begins', () => {
    const { update } = setup();
    update({ phase: 'recording', title: 'Weekly sync', startedAt: 990_000 });
    expect(mockStartMeeting).toHaveBeenCalledWith({ title: 'Weekly sync', startedAt: 990_000 });
  });

  it('falls back to now when no start time is known', () => {
    const { update } = setup();
    update({ phase: 'recording' });
    expect(mockStartMeeting).toHaveBeenCalledWith({ title: null, startedAt: 1_000_000 });
  });

  it('does not restart the card when the title changes mid-recording', () => {
    const { update } = setup();
    update({ phase: 'recording', title: 'A', startedAt: 990_000 });
    update({ phase: 'recording', title: 'B', startedAt: 990_000 });
    expect(mockStartMeeting).toHaveBeenCalledTimes(1);
  });

  it('reports captured, not wall-clock, seconds when processing starts', () => {
    const { update } = setup();
    update({ phase: 'recording', startedAt: 958_000, capturedSeconds: 0 });
    // 42 s of wall clock, of which the mic captured 30.
    update({ phase: 'recording', startedAt: 958_000, capturedSeconds: 30 });
    update({ phase: 'processing', startedAt: 958_000, capturedSeconds: 30 });
    expect(mockSetMeetingProcessing).toHaveBeenCalledWith({ recordedSeconds: 30 });
  });

  it('pauses the card when capture stops and resumes it with the captured time', () => {
    const { update } = setup();
    update({ phase: 'recording', startedAt: 990_000, capturing: true, capturedSeconds: 539 });
    update({ phase: 'recording', startedAt: 990_000, capturing: false, capturedSeconds: 540 });
    expect(mockSetMeetingCapture).toHaveBeenLastCalledWith({
      capturing: false,
      recordedSeconds: 540,
    });
    update({ phase: 'recording', startedAt: 990_000, capturing: false, capturedSeconds: 540 });
    update({ phase: 'recording', startedAt: 990_000, capturing: true, capturedSeconds: 540 });
    expect(mockSetMeetingCapture).toHaveBeenLastCalledWith({
      capturing: true,
      recordedSeconds: 540,
    });
    expect(mockSetMeetingCapture).toHaveBeenCalledTimes(2);
  });

  it('does not call setMeetingCapture outside the recording phase', () => {
    const { update } = setup();
    update({ phase: 'idle', capturing: false });
    update({ phase: 'idle', capturing: true });
    update({ phase: 'recording', startedAt: 990_000, capturing: true, capturedSeconds: 10 });
    update({ phase: 'processing', startedAt: 990_000, capturing: false, capturedSeconds: 10 });
    update({ phase: 'processing', startedAt: 990_000, capturing: true, capturedSeconds: 10 });
    update({ phase: 'idle', capturing: false });
    expect(mockSetMeetingCapture).not.toHaveBeenCalled();
  });

  it('does not report the capture state the card started with', () => {
    const { update } = setup();
    update({ phase: 'recording', startedAt: 990_000, capturing: true });
    update({ phase: 'recording', startedAt: 990_000, capturing: true, capturedSeconds: 5 });
    expect(mockSetMeetingCapture).not.toHaveBeenCalled();
  });

  it('ignores processing that was never preceded by a recording', () => {
    const { update } = setup();
    update({ phase: 'processing' });
    expect(mockSetMeetingProcessing).not.toHaveBeenCalled();
  });

  it('ends the meeting when processing finishes back to idle', () => {
    const { update } = setup();
    update({ phase: 'recording', startedAt: 990_000 });
    update({ phase: 'processing' });
    update({ phase: 'idle' });
    expect(mockEndMeeting).toHaveBeenCalledTimes(1);
  });

  it('recording → idle ends the meeting', () => {
    const { update } = setup();
    update({ phase: 'recording', startedAt: 990_000 });
    update({ phase: 'idle' });
    expect(mockEndMeeting).toHaveBeenCalledTimes(1);
  });

  it('ends the meeting on unmount mid-meeting', () => {
    const { update, unmount } = setup();
    update({ phase: 'recording', startedAt: 990_000 });
    unmount();
    expect(mockEndMeeting).toHaveBeenCalledTimes(1);
  });

  it('does not end anything on unmount when no meeting ran', () => {
    const { unmount } = setup();
    unmount();
    expect(mockEndMeeting).not.toHaveBeenCalled();
  });

  it('forwards a lock-screen End while recording', () => {
    const { update, onEndRequested } = setup();
    update({ phase: 'recording', startedAt: 990_000 });
    mockEndListener?.();
    expect(onEndRequested).toHaveBeenCalledTimes(1);
  });

  it('End fired twice while recording calls onEndRequested once', () => {
    const { update, onEndRequested } = setup();
    update({ phase: 'recording', startedAt: 990_000 });
    mockEndListener?.();
    mockEndListener?.();
    expect(onEndRequested).toHaveBeenCalledTimes(1);
  });

  it('allows End again for the next meeting', () => {
    const { update, onEndRequested } = setup();
    update({ phase: 'recording', startedAt: 990_000 });
    mockEndListener?.();
    update({ phase: 'idle' });
    update({ phase: 'recording', startedAt: 995_000 });
    mockEndListener?.();
    expect(onEndRequested).toHaveBeenCalledTimes(2);
  });

  it('ignores End while processing or idle', () => {
    const { update, onEndRequested } = setup();
    mockEndListener?.();
    update({ phase: 'recording', startedAt: 990_000 });
    update({ phase: 'processing' });
    mockEndListener?.();
    expect(onEndRequested).not.toHaveBeenCalled();
  });

  it('calls the latest onEndRequested callback', () => {
    const { update } = setup();
    const latest = jest.fn();
    update({ phase: 'recording', startedAt: 990_000, onEndRequested: latest });
    mockEndListener?.();
    expect(latest).toHaveBeenCalledTimes(1);
  });

  it('removes the End listener on unmount', () => {
    const { unmount } = setup();
    unmount();
    expect(mockRemove).toHaveBeenCalledTimes(1);
  });
});

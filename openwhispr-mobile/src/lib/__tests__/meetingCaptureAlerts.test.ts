import { act, renderHook } from '@testing-library/react-native';
import { Alert, AppState, Platform, type AppStateStatus } from 'react-native';
import { captureCoverage } from '@/lib/notes/meetingCapture';
import {
  alertIfPartialCapture,
  cancelCapturePausedNotification,
  scheduleCapturePausedNotification,
  useCapturePausedNotification,
} from '../meetingCaptureAlerts';

const mockSchedule = jest.fn();
const mockCancel = jest.fn();
const mockDismiss = jest.fn();
const mockGetNotificationStatus = jest.fn();
const mockRequestNotifications = jest.fn();

jest.mock('expo-notifications', () => ({
  SchedulableTriggerInputTypes: { TIME_INTERVAL: 'timeInterval' },
  scheduleNotificationAsync: (input: unknown) => mockSchedule(input),
  cancelScheduledNotificationAsync: (id: string) => mockCancel(id),
  dismissNotificationAsync: (id: string) => mockDismiss(id),
}));

jest.mock('@/lib/notifications', () => ({
  getNotificationStatus: () => mockGetNotificationStatus(),
  requestNotifications: () => mockRequestNotifications(),
}));

let appStateListener: ((state: AppStateStatus) => void) | undefined;
const mockRemoveAppStateListener = jest.fn();

function setPlatform(os: 'ios' | 'android'): void {
  Object.defineProperty(Platform, 'OS', { value: os, configurable: true });
}

function setAppState(state: AppStateStatus): void {
  Object.defineProperty(AppState, 'currentState', { value: state, configurable: true });
}

beforeEach(() => {
  jest.clearAllMocks();
  appStateListener = undefined;
  mockSchedule.mockResolvedValue('notification-1');
  mockCancel.mockResolvedValue(undefined);
  mockDismiss.mockResolvedValue(undefined);
  mockGetNotificationStatus.mockResolvedValue('granted');
  setAppState('background');
  setPlatform('ios');
  jest.spyOn(AppState, 'addEventListener').mockImplementation((_type, listener) => {
    appStateListener = listener as (state: AppStateStatus) => void;
    return { remove: mockRemoveAppStateListener } as unknown as ReturnType<
      typeof AppState.addEventListener
    >;
  });
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('scheduleCapturePausedNotification', () => {
  it('schedules a 20 s notification when backgrounded and granted', async () => {
    await expect(scheduleCapturePausedNotification()).resolves.toBe('notification-1');
    expect(mockSchedule).toHaveBeenCalledWith({
      content: {
        title: 'Meeting recording paused',
        body: 'Open OpenWhispr to resume recording.',
      },
      trigger: { type: 'timeInterval', seconds: 20 },
    });
  });

  it('notifies at once for a delay of 0', async () => {
    await expect(scheduleCapturePausedNotification(0)).resolves.toBe('notification-1');
    expect(mockSchedule).toHaveBeenCalledWith({
      content: {
        title: 'Meeting recording paused',
        body: 'Open OpenWhispr to resume recording.',
      },
      trigger: null,
    });
  });

  it('returns null off iOS without touching notifications', async () => {
    setPlatform('android');
    await expect(scheduleCapturePausedNotification()).resolves.toBeNull();
    expect(mockSchedule).not.toHaveBeenCalled();
    expect(mockGetNotificationStatus).not.toHaveBeenCalled();
  });

  it('returns null when the app is active', async () => {
    setAppState('active');
    await expect(scheduleCapturePausedNotification()).resolves.toBeNull();
    expect(mockSchedule).not.toHaveBeenCalled();
  });

  it('returns null without asking when permission is not granted', async () => {
    mockGetNotificationStatus.mockResolvedValue('undetermined');
    await expect(scheduleCapturePausedNotification()).resolves.toBeNull();
    expect(mockSchedule).not.toHaveBeenCalled();
    expect(mockRequestNotifications).not.toHaveBeenCalled();
  });

  it('returns null when scheduling fails', async () => {
    mockSchedule.mockRejectedValue(new Error('no'));
    await expect(scheduleCapturePausedNotification()).resolves.toBeNull();
  });
});

describe('cancelCapturePausedNotification', () => {
  it('cancels a scheduled notification and removes a delivered one', async () => {
    await cancelCapturePausedNotification('notification-1');
    expect(mockCancel).toHaveBeenCalledWith('notification-1');
    expect(mockDismiss).toHaveBeenCalledWith('notification-1');
  });

  it('still removes a delivered notification when cancelling fails', async () => {
    mockCancel.mockRejectedValue(new Error('gone'));
    await cancelCapturePausedNotification('notification-1');
    expect(mockDismiss).toHaveBeenCalledWith('notification-1');
  });

  it('ignores a null id', async () => {
    await cancelCapturePausedNotification(null);
    expect(mockCancel).not.toHaveBeenCalled();
  });
});

describe('useCapturePausedNotification', () => {
  type Props = { active: boolean; capturing: boolean };
  const render = (initial: Props): ReturnType<typeof renderHook<void, Props>> =>
    renderHook((p: Props) => useCapturePausedNotification(p.active, p.capturing), {
      initialProps: initial,
    });

  it('schedules when capture stops and cancels when it resumes', async () => {
    const hook = render({ active: true, capturing: true });
    expect(mockSchedule).not.toHaveBeenCalled();
    await act(async () => hook.rerender({ active: true, capturing: false }));
    expect(mockSchedule).toHaveBeenCalledTimes(1);
    await act(async () => hook.rerender({ active: true, capturing: true }));
    expect(mockCancel).toHaveBeenCalledWith('notification-1');
  });

  it('cancels when the recording ends or the screen unmounts', async () => {
    const hook = render({ active: true, capturing: false });
    await act(async () => {});
    await act(async () => hook.rerender({ active: false, capturing: false }));
    expect(mockCancel).toHaveBeenCalledWith('notification-1');
    mockCancel.mockClear();
    await act(async () => hook.rerender({ active: true, capturing: false }));
    hook.unmount();
    await act(async () => {});
    expect(mockCancel).toHaveBeenCalledWith('notification-1');
    expect(mockRemoveAppStateListener).toHaveBeenCalled();
  });

  it('cancels a notification whose scheduling finishes after capture resumed', async () => {
    let resolveSchedule: (id: string) => void = () => {};
    mockSchedule.mockReturnValue(
      new Promise<string>((resolve) => {
        resolveSchedule = resolve;
      }),
    );
    const hook = render({ active: true, capturing: false });
    await act(async () => hook.rerender({ active: true, capturing: true }));
    await act(async () => resolveSchedule('late'));
    expect(mockCancel).toHaveBeenCalledWith('late');
  });

  it('schedules once the app leaves the foreground while capture is stopped', async () => {
    setAppState('active');
    render({ active: true, capturing: false });
    await act(async () => {});
    expect(mockSchedule).not.toHaveBeenCalled();
    setAppState('background');
    await act(async () => appStateListener?.('background'));
    expect(mockSchedule).toHaveBeenCalledTimes(1);
    await act(async () => appStateListener?.('background'));
    expect(mockSchedule).toHaveBeenCalledTimes(1);
  });

  it('cancels a waiting notification once the app is back in the foreground', async () => {
    setAppState('inactive');
    render({ active: true, capturing: false });
    await act(async () => {});
    expect(mockSchedule).toHaveBeenCalledTimes(1);
    setAppState('active');
    await act(async () => appStateListener?.('active'));
    expect(mockCancel).toHaveBeenCalledWith('notification-1');
  });

  it('notifies at once when interrupted in the background', async () => {
    const hook = render({ active: true, capturing: true });
    await act(async () => hook.rerender({ active: true, capturing: false }));
    expect(mockSchedule).toHaveBeenCalledTimes(1);
    expect(mockSchedule).toHaveBeenCalledWith(expect.objectContaining({ trigger: null }));
  });

  it('notifies at once when backgrounded 2 s after a pause in the foreground', async () => {
    const now = jest.spyOn(Date, 'now').mockReturnValue(1_000_000);
    setAppState('active');
    render({ active: true, capturing: false });
    await act(async () => {});
    expect(mockSchedule).not.toHaveBeenCalled();
    now.mockReturnValue(1_002_000);
    setAppState('background');
    await act(async () => appStateListener?.('background'));
    expect(mockSchedule).toHaveBeenCalledTimes(1);
    expect(mockSchedule).toHaveBeenCalledWith(expect.objectContaining({ trigger: null }));
  });

  it('raises nothing while a foreground pause stays on screen', async () => {
    setAppState('active');
    render({ active: true, capturing: false });
    await act(async () => {});
    setAppState('inactive');
    await act(async () => appStateListener?.('inactive'));
    expect(mockSchedule).not.toHaveBeenCalled();
  });

  it('still waits 20 s for a pause that began while inactive', async () => {
    const now = jest.spyOn(Date, 'now').mockReturnValue(1_000_000);
    setAppState('inactive');
    render({ active: true, capturing: false });
    await act(async () => {});
    expect(mockSchedule).toHaveBeenLastCalledWith(
      expect.objectContaining({ trigger: { type: 'timeInterval', seconds: 20 } }),
    );
    // Back on screen before it fired, then into the background: only the rest of the 20 s.
    now.mockReturnValue(1_002_000);
    setAppState('active');
    await act(async () => appStateListener?.('active'));
    expect(mockCancel).toHaveBeenCalledWith('notification-1');
    now.mockReturnValue(1_005_000);
    setAppState('background');
    await act(async () => appStateListener?.('background'));
    expect(mockSchedule).toHaveBeenCalledTimes(2);
    expect(mockSchedule).toHaveBeenLastCalledWith(
      expect.objectContaining({ trigger: { type: 'timeInterval', seconds: 15 } }),
    );
  });

  it('one notification per pause', async () => {
    const now = jest.spyOn(Date, 'now').mockReturnValue(1_000_000);
    render({ active: true, capturing: false });
    await act(async () => {});
    expect(mockSchedule).toHaveBeenCalledTimes(1);
    now.mockReturnValue(1_010_000);
    setAppState('active');
    await act(async () => appStateListener?.('active'));
    // Already shown: coming back leaves it, and leaving again does not raise another.
    expect(mockCancel).not.toHaveBeenCalled();
    setAppState('background');
    await act(async () => appStateListener?.('background'));
    expect(mockSchedule).toHaveBeenCalledTimes(1);
  });

  it('cleared when capture resumes', async () => {
    const hook = render({ active: true, capturing: false });
    await act(async () => {});
    expect(mockSchedule).toHaveBeenCalledWith(expect.objectContaining({ trigger: null }));
    await act(async () => hook.rerender({ active: true, capturing: true }));
    expect(mockCancel).toHaveBeenCalledWith('notification-1');
    expect(mockDismiss).toHaveBeenCalledWith('notification-1');
  });

  it('does nothing while capturing or not recording', async () => {
    const hook = render({ active: false, capturing: false });
    await act(async () => hook.rerender({ active: true, capturing: true }));
    await act(async () => appStateListener?.('background'));
    expect(mockSchedule).not.toHaveBeenCalled();
  });
});

describe('alertIfPartialCapture', () => {
  it('alerts with how much was recorded when part of the meeting is missing', () => {
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    alertIfPartialCapture(captureCoverage(540_000, 3_660_000));
    expect(alert).toHaveBeenCalledWith(
      "Part of this meeting wasn't recorded",
      'OpenWhispr recorded 9 min of this 61 min meeting. The rest was missed while the microphone or the connection was interrupted.',
    );
  });

  it('stays quiet when the whole meeting was recorded', () => {
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    alertIfPartialCapture(captureCoverage(1_795_000, 1_800_000));
    expect(alert).not.toHaveBeenCalled();
  });
});

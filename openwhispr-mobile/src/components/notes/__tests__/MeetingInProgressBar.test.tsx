import { Alert } from 'react-native';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { MeetingInProgressBar, meetingBarBottom } from '../MeetingInProgressBar';
import { Sentry } from '@/lib/sentry';
import { TAB_BAR_CLEARANCE } from '@/components/ui/tabBarClearance';
import type { MeetingSession } from '../MeetingSessionProvider';

let mockSession: Partial<MeetingSession>;
let mockSegments: string[];
let mockHandoff: boolean;
let mockAuth: { user: object | null; isGuest: boolean };
const mockNavigate = jest.fn();

jest.mock('../MeetingSessionProvider', () => ({
  useMeetingSession: (): Partial<MeetingSession> => mockSession,
}));
jest.mock('expo-router', () => ({
  router: { navigate: (...args: unknown[]): void => mockNavigate(...args) },
  useSegments: (): string[] => mockSegments,
}));
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: (): { bottom: number } => ({ bottom: 34 }),
}));
jest.mock('@/hooks/useKeyboardHeight', () => ({ useKeyboardHeight: (): number => 0 }));
jest.mock('@/store/useHandoffStore', () => ({
  useHandoffStore: (selector: (s: { isActive: boolean }) => unknown): unknown =>
    selector({ isActive: mockHandoff }),
}));
jest.mock('@/store/useAuthStore', () => ({
  useAuthStore: (selector: (s: typeof mockAuth) => unknown): unknown => selector(mockAuth),
}));
jest.mock('@/components/ui/Text', () => ({ Text: require('react-native').Text }));
jest.mock('@/lib/sentry', () => ({ Sentry: { captureException: jest.fn() } }));
jest.mock('@/lib/utils', () => ({ safeHaptics: jest.fn() }));
jest.mock('@/components/ui/SystemIcon', () => ({ SystemIcon: (): null => null }));

const stop = jest.fn(() => Promise.resolve());

beforeEach(() => {
  jest.clearAllMocks();
  mockSegments = ['(tabs)', '(record)'];
  mockHandoff = false;
  mockAuth = { user: { id: 'u' }, isGuest: false };
  mockSession = {
    phase: 'recording',
    path: 'local',
    capturing: true,
    capturedSeconds: 65,
    cloud: {
      status: 'live',
      error: null,
      startFailure: null,
      utterances: [],
      partialText: '',
      liveSinceMs: null,
    },
    stop,
  };
});

describe('MeetingInProgressBar', () => {
  it('shows the label and clock', () => {
    render(<MeetingInProgressBar />);
    expect(screen.getByText('RECORDING')).toBeTruthy();
    expect(screen.getByText('01:05')).toBeTruthy();
  });

  it.each([
    ['live', 'RECORDING'],
    ['reconnecting', 'RECONNECTING'],
    ['connecting', 'CONNECTING'],
    ['interrupted', 'NOT RECORDING'],
  ] as const)('labels a cloud meeting %s as %s', (status, label) => {
    mockSession = {
      ...mockSession,
      phase: 'cloud-recording',
      path: 'cloud',
      cloud: { ...mockSession.cloud!, status },
    };
    render(<MeetingInProgressBar />);
    expect(screen.getByText(label)).toBeTruthy();
  });

  it('labels a local meeting that is not capturing as NOT RECORDING', () => {
    mockSession = { ...mockSession, capturing: false };
    render(<MeetingInProgressBar />);
    expect(screen.getByText('NOT RECORDING')).toBeTruthy();
  });

  it('is hidden when idle', () => {
    mockSession = { ...mockSession, phase: 'idle' };
    render(<MeetingInProgressBar />);
    expect(screen.queryByText('RECORDING')).toBeNull();
  });

  it('is hidden on the meeting-record route', () => {
    mockSegments = ['(tabs)', '(notes)', 'meeting-record'];
    render(<MeetingInProgressBar />);
    expect(screen.queryByText('RECORDING')).toBeNull();
  });

  it('is hidden during the keyboard handoff', () => {
    mockHandoff = true;
    render(<MeetingInProgressBar />);
    expect(screen.queryByText('RECORDING')).toBeNull();
  });

  it('is hidden when signed out', () => {
    mockAuth = { user: null, isGuest: false };
    render(<MeetingInProgressBar />);
    expect(screen.queryByText('RECORDING')).toBeNull();
  });

  it('is shown for a guest', () => {
    mockAuth = { user: null, isGuest: true };
    render(<MeetingInProgressBar />);
    expect(screen.getByText('RECORDING')).toBeTruthy();
  });

  it('navigates to the meeting screen on tap', () => {
    render(<MeetingInProgressBar />);
    fireEvent.press(screen.getByText('RECORDING'));
    expect(mockNavigate).toHaveBeenCalledWith('/(tabs)/(notes)/meeting-record');
  });

  it('confirms before stopping, then stops', () => {
    const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    render(<MeetingInProgressBar />);
    fireEvent.press(screen.getByLabelText('End meeting'));
    expect(stop).not.toHaveBeenCalled();
    const [title, , buttons] = alertSpy.mock.calls[0];
    expect(title).toBe('End meeting?');
    expect(buttons?.map((b) => b.text)).toEqual(['Keep recording', 'End meeting']);
    buttons?.[1].onPress?.();
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it('ignores a second End while the stop is in flight', () => {
    const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    stop.mockReturnValueOnce(new Promise<void>(() => {}));
    render(<MeetingInProgressBar />);
    fireEvent.press(screen.getByLabelText('End meeting'));
    alertSpy.mock.calls[0][2]?.[1].onPress?.();
    fireEvent.press(screen.getByLabelText('End meeting'));
    expect(alertSpy).toHaveBeenCalledTimes(1);
  });

  it('shows FINISHING… with no clock and no Stop while processing', () => {
    mockSession = { ...mockSession, phase: 'processing' };
    render(<MeetingInProgressBar />);
    expect(screen.getByText('FINISHING…')).toBeTruthy();
    expect(screen.queryByText('01:05')).toBeNull();
    expect(screen.queryByLabelText('End meeting')).toBeNull();
  });

  it('Keep recording leaves the meeting running', () => {
    const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    render(<MeetingInProgressBar />);
    fireEvent.press(screen.getByLabelText('End meeting'));
    alertSpy.mock.calls[0][2]?.[0].onPress?.();
    expect(stop).not.toHaveBeenCalled();
  });

  it('pressing Stop does not navigate', () => {
    jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    render(<MeetingInProgressBar />);
    fireEvent.press(screen.getByLabelText('End meeting'));
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('passes touches through the wrapper', () => {
    const { toJSON } = render(<MeetingInProgressBar />);
    const root = toJSON() as { props: { pointerEvents?: string } };
    expect(root.props.pointerEvents).toBe('box-none');
  });

  it('a stop that rejects is reported and Stop can be pressed again', async () => {
    const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    const failure = new Error('stop failed');
    stop.mockReturnValueOnce(Promise.reject(failure));
    render(<MeetingInProgressBar />);
    fireEvent.press(screen.getByLabelText('End meeting'));
    alertSpy.mock.calls[0][2]?.[1].onPress?.();
    await act(async () => {});
    expect(Sentry.captureException).toHaveBeenCalledWith(failure);
    fireEvent.press(screen.getByLabelText('End meeting'));
    expect(alertSpy).toHaveBeenCalledTimes(2);
    alertSpy.mock.calls[1][2]?.[1].onPress?.();
    expect(stop).toHaveBeenCalledTimes(2);
  });
});

describe('meetingBarBottom', () => {
  it('sits above the tab bar, the home indicator, or the keyboard', () => {
    expect(meetingBarBottom({ tabBarVisible: true, insetBottom: 34, keyboardHeight: 0 })).toBe(
      TAB_BAR_CLEARANCE + 4,
    );
    expect(meetingBarBottom({ tabBarVisible: false, insetBottom: 34, keyboardHeight: 0 })).toBe(46);
    expect(meetingBarBottom({ tabBarVisible: true, insetBottom: 34, keyboardHeight: 300 })).toBe(
      312,
    );
  });
});

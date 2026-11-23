import { act, fireEvent, render } from '@testing-library/react-native';
import { RecordingView, smoothLevel } from '@/android/notes/RecordingView';

let mockLevel = 0.9;
const mockGetMeetingLevel = jest.fn(() => mockLevel);
jest.mock('../../../../modules/android-dictation/src', () => ({
  AndroidDictation: { getMeetingLevel: () => mockGetMeetingLevel() },
}));
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}));
jest.mock('@/components/ui/Text', () => ({ Text: require('react-native').Text }));
jest.mock('@/store/useAuthStore', () => ({ useAuthStore: () => null }));
jest.mock('@/android/notes/noteChips', () => ({ RecordingNoteChips: () => null }));
jest.mock('@/components/ui/SystemIcon', () => ({ SystemIcon: () => null }));
jest.mock('expo-router', () => ({
  router: { canGoBack: () => true, back: jest.fn() },
  useNavigation: () => ({ setOptions: jest.fn() }),
}));
jest.mock('@/android/navigationBar', () => ({
  useNavigationBarCanvas: jest.fn(),
  useNavigationBar: () => ({ buttons: true, inset: 0 }),
}));

const view = (status: 'connecting' | 'live' | 'reconnecting' | 'error') => (
  <RecordingView
    status={status}
    elapsedSeconds={5}
    title="Record a meeting"
    chips={[]}
    rawNotes=""
    onChangeRawNotes={jest.fn()}
    transcript={null}
    onStop={jest.fn()}
    keyboardHeight={0}
  />
);

// Hidden from screen readers: the pill's time already says it records.
const hidden = { includeHiddenElements: true };

describe('meeting waveform in the status pill', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    mockGetMeetingLevel.mockClear();
  });
  afterEach(() => jest.useRealTimers());

  it('fills the pill with bars that follow the meeting loudness while live', () => {
    const screen = render(view('live'));
    const waveform = screen.getByTestId('meeting-waveform', hidden);
    // 57 px holds ten 3 px bars with 3 px gaps, plus one sliding out under the edge.
    fireEvent(waveform, 'layout', { nativeEvent: { layout: { width: 57, height: 18 } } });
    expect(screen.getByTestId('meeting-waveform-bars', hidden).children).toHaveLength(11);
    act(() => jest.advanceTimersByTime(800));
    expect(mockGetMeetingLevel).toHaveBeenCalled();
    const bars = screen.getByTestId('meeting-waveform-bars', hidden).children as {
      props: { style: { height: number } };
    }[];
    expect(bars[bars.length - 1].props.style.height).toBe(18);
    expect(bars[0].props.style.height).toBe(3);
  });

  it('eases each bar toward the new loudness rather than jumping to it', () => {
    expect(smoothLevel(0, 1)).toBeCloseTo(0.55);
    expect(smoothLevel(0.5, 0.5)).toBeCloseTo(0.5);
  });

  it('stays flat and reads nothing while it reconnects, and is gone on an error', () => {
    const screen = render(view('reconnecting'));
    act(() => jest.advanceTimersByTime(400));
    expect(mockGetMeetingLevel).not.toHaveBeenCalled();
    expect(screen.getByTestId('meeting-waveform', hidden)).toBeTruthy();
    screen.rerender(view('error'));
    expect(screen.queryByTestId('meeting-waveform', hidden)).toBeNull();
  });
});

import { fireEvent, render } from '@testing-library/react-native';
import { Platform, ScrollView } from 'react-native';
import { CloudMeetingRecording as IOSRecording } from '../CloudMeetingRecording';
import { CloudMeetingRecording as AndroidRecording } from '../CloudMeetingRecording.android';
import { LiveTranscriptList as IOSList } from '../LiveTranscriptList';
import { LiveTranscriptList as AndroidList } from '../LiveTranscriptList.android';
import type { RealtimeUtterance } from '@/services/transcription/realtimeEvents';

let mockKeyboardHeight = 0;
let mockBottomInset = 0;
jest.mock('@/hooks/useKeyboardHeight', () => ({ useKeyboardHeight: () => mockKeyboardHeight }));
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 54, right: 0, bottom: mockBottomInset, left: 0 }),
}));
jest.mock('@react-navigation/elements', () => ({ useHeaderHeight: () => 64 }));
jest.mock('@/components/ui/Text', () => ({ Text: require('react-native').Text }));
jest.mock('@/components/ui/Button', () => ({ Button: require('react-native').Pressable }));
jest.mock('@/config/colors', () => ({ BRAND: '#007AFF', iosColor: (name: string) => name }));

const finalUtterance = { itemId: 'one', text: 'Hello there.' } as RealtimeUtterance;
const contents = [
  { name: 'empty', utterances: [], partialText: '' },
  { name: 'final', utterances: [finalUtterance], partialText: '' },
  { name: 'partial', utterances: [], partialText: 'Still speaking' },
  { name: 'mixed', utterances: [finalUtterance], partialText: 'Still speaking' },
];
const cases = ['connecting', 'live', 'reconnecting', 'error'].flatMap((status) =>
  contents.flatMap((content) => [0, 180].map((keyboard) => ({ status, content, keyboard }))),
);

beforeEach(() => {
  jest.clearAllMocks();
  mockKeyboardHeight = 0;
  mockBottomInset = 24;
  jest.spyOn(ScrollView.prototype, 'scrollToEnd').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

describe.each([
  { platform: 'ios' as const, Recording: IOSRecording, List: IOSList },
  { platform: 'android' as const, Recording: AndroidRecording, List: AndroidList },
])('$platform cloud presentation', ({ platform, Recording, List }) => {
  beforeEach(() => {
    Platform.OS = platform;
  });

  it.each(cases)(
    '$status / $content.name / keyboard=$keyboard',
    ({ status, content, keyboard }) => {
      mockKeyboardHeight = keyboard;
      mockBottomInset = keyboard ? 0 : 24;
      const onStop = jest.fn();
      const screen = render(
        <Recording
          status={status as 'connecting' | 'live' | 'reconnecting' | 'error'}
          error={status === 'error' ? 'Connection lost' : null}
          elapsedSeconds={125}
          rawNotes="Draft note"
          onChangeRawNotes={jest.fn()}
          utterances={content.utterances}
          partialText={content.partialText}
          onStop={onStop}
        />,
      );
      const empty = content.name === 'empty';
      const active = platform === 'ios' || status !== 'error';
      expect(!!screen.queryByText('Listening… speak to see the transcript.')).toBe(empty && active);
      expect(!!screen.queryByText('Transcribing…')).toBe(!empty && active);
      expect(!!screen.queryByText('Connection lost')).toBe(status === 'error');
      expect(!!screen.queryByText('Reconnecting — recording continues')).toBe(
        status === 'reconnecting',
      );
      expect(screen.getByText('02:05')).toBeTruthy();
      if (content.utterances.length)
        expect(screen.getByText('Hello there.').props.selectable).toBe(
          platform === 'android' ? true : undefined,
        );
      let footer = screen.getByTestId('meeting-stop');
      while (footer.parent && footer.props.className !== 'px-4 pt-2') footer = footer.parent;
      expect(footer.props.style.paddingBottom).toBe(
        keyboard ? (platform === 'android' ? 12 : 192) : 40,
      );
      fireEvent.press(screen.getByTestId('meeting-stop'));
      expect(onStop).toHaveBeenCalledTimes(1);
    },
  );

  it('keeps tabs, note edits, Stop and keyboard transitions', () => {
    const onChangeRawNotes = jest.fn();
    const onStop = jest.fn();
    const props = {
      status: 'live' as const,
      error: null,
      elapsedSeconds: 9,
      rawNotes: 'First draft',
      onChangeRawNotes,
      utterances: [finalUtterance],
      partialText: '',
      onStop,
    };
    const screen = render(<Recording {...props} />);
    fireEvent.press(screen.getByTestId('meeting-tab-notes'));
    expect(screen.getByTestId('meeting-raw-notes').props.value).toBe('First draft');
    fireEvent.changeText(screen.getByTestId('meeting-raw-notes'), 'Changed draft');
    expect(onChangeRawNotes).toHaveBeenCalledWith('Changed draft');
    mockKeyboardHeight = 210;
    screen.rerender(<Recording {...props} rawNotes="Changed draft" />);
    expect(screen.getByTestId('meeting-raw-notes').props.value).toBe('Changed draft');
    fireEvent.press(screen.getByTestId('meeting-tab-transcript'));
    expect(screen.getByText('Hello there.')).toBeTruthy();
    fireEvent.press(screen.getByTestId('meeting-stop'));
    expect(onStop).toHaveBeenCalledTimes(1);
  });

  it('keeps the platform Stop label contract', () => {
    const extra = { stopLabel: 'Retry save' };
    const screen = render(
      <Recording
        status="error"
        error={null}
        elapsedSeconds={0}
        rawNotes=""
        onChangeRawNotes={jest.fn()}
        utterances={[]}
        partialText=""
        onStop={jest.fn()}
        {...extra}
      />,
    );
    const children = screen.getByTestId('meeting-stop').props.children;
    expect(Array.isArray(children) ? children[0] : children).toBe(
      platform === 'android' ? 'Retry save' : 'Stop',
    );
  });

  it.each(contents)(
    'keeps standalone transcript active state for $name',
    ({ utterances, partialText, name }) => {
      const screen = render(
        <List utterances={utterances} partialText={partialText} {...{ active: false }} />,
      );
      expect(!!screen.queryByText('Listening… speak to see the transcript.')).toBe(
        platform === 'ios' && name === 'empty',
      );
      expect(!!screen.queryByText('Transcribing…')).toBe(platform === 'ios' && name !== 'empty');
    },
  );

  it('scrolls only when transcript length or partial text changes', () => {
    const screen = render(<List utterances={[]} partialText="" />);
    expect(ScrollView.prototype.scrollToEnd).toHaveBeenCalledTimes(1);
    screen.rerender(<List utterances={[]} partialText="" />);
    expect(ScrollView.prototype.scrollToEnd).toHaveBeenCalledTimes(1);
    screen.rerender(<List utterances={[]} partialText="Starting" />);
    expect(ScrollView.prototype.scrollToEnd).toHaveBeenCalledTimes(2);
    screen.rerender(<List utterances={[finalUtterance]} partialText="" />);
    expect(ScrollView.prototype.scrollToEnd).toHaveBeenCalledTimes(3);
    screen.rerender(
      <List utterances={[{ ...finalUtterance, text: 'Edited final' }]} partialText="" />,
    );
    expect(ScrollView.prototype.scrollToEnd).toHaveBeenCalledTimes(3);
    expect(screen.getByText('Edited final')).toBeTruthy();
  });
});

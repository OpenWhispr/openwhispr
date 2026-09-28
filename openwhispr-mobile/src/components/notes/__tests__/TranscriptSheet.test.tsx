import { Alert, Share, Text } from 'react-native';
import { act, fireEvent, render } from '@testing-library/react-native';
import type { TranscriptBlock } from '@/lib/diarization/transcriptDisplay';
import { TranscriptSheet } from '../TranscriptSheet';

jest.mock('@react-native-menu/menu', () => ({
  MenuView: ({
    actions,
    onPressAction,
    children,
  }: {
    actions: { id: string; title: string }[];
    onPressAction: (event: { nativeEvent: { event: string } }) => void;
    children?: React.ReactNode;
  }) => {
    const { Pressable, Text: MockText, View } = require('react-native');
    return (
      <View>
        {children}
        {actions.map((action) => (
          <Pressable
            key={action.id}
            testID={`menu-${action.id}`}
            onPress={() => onPressAction({ nativeEvent: { event: action.id } })}
          >
            <MockText>{action.title}</MockText>
          </Pressable>
        ))}
      </View>
    );
  },
}));
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}));
jest.mock('@/components/ui/Text', () => ({ Text: require('react-native').Text }));
jest.mock('@/components/ui/SystemIcon', () => ({ SystemIcon: () => null }));
jest.mock('@/components/ui/GlassIconButton', () => ({
  GlassCapsule: ({ children }: { children?: React.ReactNode }) => children,
  GlassIconButton: ({
    children,
    onPress,
    accessibilityLabel,
  }: {
    children?: React.ReactNode;
    onPress?: () => void;
    accessibilityLabel?: string;
  }) => {
    const { Pressable } = require('react-native');
    return (
      <Pressable accessibilityLabel={accessibilityLabel} onPress={onPress}>
        {children}
      </Pressable>
    );
  },
}));

const block: TranscriptBlock = {
  id: 'b1',
  speakerId: 10,
  speakerLabel: 'speaker_0',
  speakerName: 'Speaker 1',
  speakerColor: '#FF0000',
  speakerStatus: 'provisional',
  startMs: 0,
  endMs: 1000,
  timestamp: '0:00',
  text: 'Hello there',
  segmentIds: [1],
};

const renderSheet = (overrides: Partial<React.ComponentProps<typeof TranscriptSheet>> = {}) =>
  render(
    <TranscriptSheet
      visible
      blocks={[block]}
      selectedSpeakerId={null}
      shareText="[0:00] Speaker 1: Hello there"
      onSpeakerPress={jest.fn()}
      onExport={jest.fn()}
      onClose={jest.fn()}
      {...overrides}
    />,
  );

describe('TranscriptSheet', () => {
  it('shows the title, subtitle and transcript', () => {
    const { getByText } = renderSheet();
    expect(getByText('Transcript')).toBeTruthy();
    expect(getByText('Review, share or export the full transcript.')).toBeTruthy();
    expect(getByText('Hello there')).toBeTruthy();
  });

  it('hands a tapped speaker to the caller', () => {
    const onSpeakerPress = jest.fn();
    const { getByTestId } = renderSheet({ onSpeakerPress });
    fireEvent.press(getByTestId('speaker-button-10'));
    expect(onSpeakerPress).toHaveBeenCalledWith(block);
  });

  it('shares the transcript text', async () => {
    const shareSpy = jest.spyOn(Share, 'share').mockResolvedValue({ action: 'sharedAction' });
    const { getByTestId } = renderSheet();
    await act(async () => {
      fireEvent.press(getByTestId('menu-share'));
    });
    expect(shareSpy).toHaveBeenCalledWith({ message: '[0:00] Speaker 1: Hello there' });
    shareSpy.mockRestore();
  });

  it('explains when sharing fails', async () => {
    const shareSpy = jest.spyOn(Share, 'share').mockRejectedValue(new Error('nope'));
    const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
    const { getByTestId } = renderSheet();
    await act(async () => {
      fireEvent.press(getByTestId('menu-share'));
    });
    expect(alertSpy).toHaveBeenCalledWith('Error', 'Unable to share transcript');
    shareSpy.mockRestore();
    alertSpy.mockRestore();
  });

  it('exports the transcript as a Markdown or text file', () => {
    const onExport = jest.fn();
    const { getByTestId, getByText } = renderSheet({ onExport });
    expect(getByText('Export Markdown')).toBeTruthy();
    expect(getByText('Export Plain Text')).toBeTruthy();

    fireEvent.press(getByTestId('menu-export-md'));
    fireEvent.press(getByTestId('menu-export-txt'));

    expect(onExport.mock.calls).toEqual([['md'], ['txt']]);
  });

  it('closes from the close button', () => {
    const onClose = jest.fn();
    const { getByLabelText } = renderSheet({ onClose });
    fireEvent.press(getByLabelText('Close'));
    expect(onClose).toHaveBeenCalled();
  });

  it('renders its children inside the sheet so speaker sheets can present above it', () => {
    const { getByText } = renderSheet({ children: <Text>rename-sheet</Text> });
    expect(getByText('rename-sheet')).toBeTruthy();
  });
});

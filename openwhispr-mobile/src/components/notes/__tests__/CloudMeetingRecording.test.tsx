import { render } from '@testing-library/react-native';
import type { CloudMeetingStatus } from '@/hooks/useCloudMeeting';
import { CloudMeetingRecording } from '../CloudMeetingRecording';

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
jest.mock('@react-navigation/elements', () => ({ useHeaderHeight: () => 0 }));
jest.mock('@/hooks/useKeyboardHeight', () => ({ useKeyboardHeight: () => 0 }));
jest.mock('@/components/ui/Text', () => ({ Text: require('react-native').Text }));
jest.mock('../LiveTranscriptList', () => ({ LiveTranscriptList: () => null }));

const renderIndicator = (status: CloudMeetingStatus, captureStarted: boolean) =>
  render(
    <CloudMeetingRecording
      status={status}
      captureStarted={captureStarted}
      error={null}
      capturedSeconds={0}
      rawNotes=""
      onChangeRawNotes={jest.fn()}
      utterances={[]}
      partialText=""
      onStop={jest.fn()}
    />,
  );

const dotClass = (screen: ReturnType<typeof renderIndicator>): string =>
  screen.getByTestId('meeting-status-dot').props.className;

describe('CloudMeetingRecording status indicator', () => {
  it('shows the red dot while a recorded meeting connects once capture has started', () => {
    const screen = renderIndicator('connecting', true);

    expect(dotClass(screen)).toContain('bg-systemRed');
    expect(screen.getByText('CONNECTING')).toBeTruthy();
  });

  it('shows the grey dot while a meeting with no recording connects', () => {
    const screen = renderIndicator('connecting', false);

    expect(dotClass(screen)).toContain('bg-tertiaryLabel');
    expect(dotClass(screen)).not.toContain('bg-systemRed');
    expect(screen.getByText('CONNECTING')).toBeTruthy();
  });

  it('reads NOT RECORDING with the grey dot when capture is interrupted', () => {
    const screen = renderIndicator('interrupted', true);

    expect(screen.getByText('NOT RECORDING')).toBeTruthy();
    expect(dotClass(screen)).toContain('bg-tertiaryLabel');
    expect(screen.getByText('The microphone was interrupted. Trying to resume…')).toBeTruthy();
  });
});

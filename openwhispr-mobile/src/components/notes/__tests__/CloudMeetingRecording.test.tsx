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

const renderError = (error: string | null, startFailed: boolean) =>
  render(
    <CloudMeetingRecording
      status="error"
      captureStarted={false}
      error={error}
      startFailed={startFailed}
      capturedSeconds={0}
      rawNotes=""
      onChangeRawNotes={jest.fn()}
      utterances={[]}
      partialText=""
      onStop={jest.fn()}
    />,
  );

describe('CloudMeetingRecording error line', () => {
  it('says a meeting that ended mid-way has stopped recording', () => {
    const screen = renderError('Realtime WebSocket closed (code 1011)', false);

    expect(
      screen.getByText('Realtime WebSocket closed (code 1011). Recording has stopped.'),
    ).toBeTruthy();
  });

  it('never says a meeting that never started has stopped recording', () => {
    const screen = renderError('Session activation failed', true);

    expect(screen.queryByText(/Recording has stopped/)).toBeNull();
    expect(screen.queryByText(/Session activation failed/)).toBeNull();
  });
});

const renderReconnecting = (recording: boolean) =>
  render(
    <CloudMeetingRecording
      status="reconnecting"
      captureStarted
      recording={recording}
      error={null}
      capturedSeconds={0}
      rawNotes=""
      onChangeRawNotes={jest.fn()}
      utterances={[]}
      partialText=""
      onStop={jest.fn()}
    />,
  );

describe('CloudMeetingRecording reconnecting line', () => {
  it('says the outage is transcribed later while the recording is healthy', () => {
    const screen = renderReconnecting(true);

    expect(
      screen.getByText(
        "Connection lost. Still recording — this part will be transcribed when you're back online.",
      ),
    ).toBeTruthy();
    expect(screen.queryByText(/isn't being transcribed/)).toBeNull();
  });

  it('says the speech is lost when there is no healthy recording', () => {
    const screen = renderReconnecting(false);

    expect(
      screen.getByText("Connection lost. Reconnecting… speech isn't being transcribed right now."),
    ).toBeTruthy();
    expect(screen.queryByText(/Still recording/)).toBeNull();
  });
});

const renderRecordingOnly = (error: string | null) =>
  render(
    <CloudMeetingRecording
      status="recording-only"
      captureStarted
      recording
      error={error}
      capturedSeconds={0}
      rawNotes=""
      onChangeRawNotes={jest.fn()}
      utterances={[]}
      partialText=""
      onStop={jest.fn()}
    />,
  );

describe('CloudMeetingRecording after the live stream ended', () => {
  it('reads as recording and says why live text stopped and that the rest comes later', () => {
    const screen = renderRecordingOnly('Unauthorized');

    expect(screen.getByText('RECORDING ONLY')).toBeTruthy();
    expect(dotClass(screen)).toContain('bg-systemRed');
    expect(
      screen.getByText(
        'Unauthorized. Live transcription stopped. Still recording, so the rest can be transcribed after the meeting.',
      ),
    ).toBeTruthy();
    expect(screen.queryByText(/Recording has stopped/)).toBeNull();
  });

  it('says the same without a reason', () => {
    const screen = renderRecordingOnly(null);

    expect(
      screen.getByText(
        'Live transcription stopped. Still recording, so the rest can be transcribed after the meeting.',
      ),
    ).toBeTruthy();
  });
});

import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import * as FileSystem from 'expo-file-system/legacy';
import type { SpeakerProfile } from '@/data/types';
import { VoiceProfileList } from '../VoiceProfileList';
import { VoiceEnrollmentRecorder } from '../VoiceEnrollmentRecorder';
import { VoiceProfilePromptCard } from '../VoiceProfilePromptCard';
import { useAudioRecording } from '@/hooks/useAudioRecording';

jest.mock('@/components/ui/Text', () => ({ Text: require('react-native').Text }));
jest.mock('@/components/ui/SystemIcon', () => ({ SystemIcon: () => null }));
jest.mock('@/components/ui/SwipeableCard', () => ({
  SwipeableCard: ({ children }: any) => children,
}));
jest.mock('../SectionHeader', () => ({ SectionHeader: () => null }));
jest.mock('@/components/ui/GradientGlassSurface', () => ({ GradientGlassSurface: () => null }));
jest.mock('@/components/features/WaveformVisualizer', () => ({ WaveformVisualizer: () => null }));
jest.mock('expo-file-system/legacy', () => ({
  deleteAsync: jest.fn(async () => undefined),
}));
jest.mock('@/components/ui/Button', () => {
  const mockReact = require('react');
  const mockText = require('react-native').Text;
  return {
    Button: function MockButton(props: any) {
      return mockReact.createElement(
        mockText,
        {
          onPress: props.disabled ? undefined : props.onPress,
          testID: props.testID,
          accessibilityState: props.accessibilityState,
        },
        props.children,
      );
    },
  };
});
jest.mock('@/hooks/useAudioRecording', () => ({
  useAudioRecording: jest.fn(),
}));

const profile = (overrides: Partial<SpeakerProfile> = {}): SpeakerProfile =>
  ({
    id: 1,
    displayName: 'Me',
    email: null,
    isOwner: 1,
    embedding: [1, 0],
    sampleCount: 2,
    consentAt: '2026-06-19T12:00:00.000Z',
    createdAt: '2026-06-19 12:00:00',
    updatedAt: null,
    ...overrides,
  }) as SpeakerProfile;

const baseListProps = {
  onEnrollOwner: jest.fn(),
  onEnrollSpeaker: jest.fn(),
  onOpenProfile: jest.fn(),
  onDelete: jest.fn(),
};

const mockUseAudioRecording = useAudioRecording as jest.MockedFunction<typeof useAudioRecording>;

describe('VoiceProfileList', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('renders owner badge and opens the profile on row press', () => {
    const onOpenProfile = jest.fn();
    const { getByText, getByTestId } = render(
      <VoiceProfileList profiles={[profile()]} {...baseListProps} onOpenProfile={onOpenProfile} />,
    );

    expect(getByText('Owner')).toBeTruthy();

    fireEvent.press(getByTestId('voice-profile-row-1'));

    expect(onOpenProfile).toHaveBeenCalledWith(expect.objectContaining({ id: 1 }));
  });

  it('offers owner enrollment in the empty state', () => {
    const onEnrollOwner = jest.fn();
    const { getByTestId } = render(
      <VoiceProfileList profiles={[]} {...baseListProps} onEnrollOwner={onEnrollOwner} />,
    );

    fireEvent.press(getByTestId('voice-profile-enroll-owner-empty'));

    expect(onEnrollOwner).toHaveBeenCalled();
  });

  it('hides the owner enrollment action once an owner exists', () => {
    const { queryByTestId, getByTestId } = render(
      <VoiceProfileList
        profiles={[profile(), profile({ id: 2, displayName: 'Alice', isOwner: 0 })]}
        {...baseListProps}
      />,
    );

    expect(queryByTestId('voice-profile-enroll-owner')).toBeNull();
    expect(getByTestId('voice-profile-enroll-speaker')).toBeTruthy();
  });
});

describe('VoiceProfilePromptCard', () => {
  it('shows only when no owner profile prompt is visible and supports dismiss', () => {
    const onDismiss = jest.fn();
    const { queryByTestId, rerender, getByTestId } = render(
      <VoiceProfilePromptCard visible={false} onEnroll={() => {}} onDismiss={onDismiss} />,
    );

    expect(queryByTestId('voice-profile-prompt-card')).toBeNull();

    rerender(<VoiceProfilePromptCard visible onEnroll={() => {}} onDismiss={onDismiss} />);
    fireEvent.press(getByTestId('voice-profile-prompt-dismiss'));

    expect(onDismiss).toHaveBeenCalled();
  });
});

describe('VoiceEnrollmentRecorder', () => {
  const startRecording = jest.fn(async () => undefined);
  const stopRecordingRaw = jest.fn(async () => 'file://take1.wav');

  beforeEach(() => {
    jest.clearAllMocks();
    mockUseAudioRecording.mockReturnValue({
      isRecording: false,
      isProcessing: false,
      currentText: '',
      isSupported: true,
      startRecording,
      stopRecording: jest.fn(),
      stopRecordingRaw,
      cancelRecording: jest.fn(),
      audioRecorder: {} as ReturnType<typeof useAudioRecording>['audioRecorder'],
    });
  });

  it('records a take and submits with the consent timestamp from the first take', async () => {
    const onSubmit = jest.fn(async () => undefined);
    const now = () => new Date('2026-06-19T09:00:00.000Z');
    const { getByTestId, getByText } = render(
      <VoiceEnrollmentRecorder isOwner onSubmit={onSubmit} now={now} />,
    );

    fireEvent.press(getByTestId('voice-enrollment-save'));
    expect(onSubmit).not.toHaveBeenCalled();

    fireEvent.press(getByTestId('voice-enrollment-record'));
    await waitFor(() => expect(startRecording).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(getByText('Stop')).toBeTruthy());
    fireEvent.press(getByTestId('voice-enrollment-record'));
    await waitFor(() => expect(stopRecordingRaw).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(getByText('1 of 2 recorded')).toBeTruthy());
    fireEvent.press(getByTestId('voice-enrollment-save'));

    await waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith(
        expect.objectContaining({
          consentAccepted: true,
          consentAcceptedAt: '2026-06-19T09:00:00.000Z',
          recordings: [{ uri: 'file://take1.wav', mimeType: 'audio/wav' }],
        }),
      ),
    );
  });

  it('shows retry on quality failure and enables save after an accepted take', async () => {
    const onSubmit = jest.fn(async () => {
      throw new Error('Speech activity is below 10000ms.');
    });
    const { getByTestId, getByText } = render(
      <VoiceEnrollmentRecorder isOwner onSubmit={onSubmit} />,
    );

    fireEvent.press(getByTestId('voice-enrollment-record'));
    await waitFor(() => expect(getByText('Stop')).toBeTruthy());
    fireEvent.press(getByTestId('voice-enrollment-record'));
    await waitFor(() => expect(stopRecordingRaw).toHaveBeenCalledTimes(1));

    expect(getByTestId('voice-enrollment-save').props.accessibilityState.disabled).toBe(false);

    await act(async () => {
      fireEvent.press(getByText('Save'));
    });

    await waitFor(() => expect(getByText('Speech activity is below 10000ms.')).toBeTruthy());
    expect(FileSystem.deleteAsync).toHaveBeenCalledWith('file://take1.wav', {
      idempotent: true,
    });
    expect(getByText('0 of 2 recorded')).toBeTruthy();
    expect(getByTestId('voice-enrollment-retry')).toBeTruthy();
  });
});

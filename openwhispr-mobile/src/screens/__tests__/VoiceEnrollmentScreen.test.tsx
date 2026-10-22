import { Alert } from 'react-native';
import { fireEvent, render, waitFor } from '@testing-library/react-native';
import VoiceEnrollmentScreen from '../VoiceEnrollmentScreen';
import { SpeakerProfileOwnerAlreadyExistsError } from '@/data/local/notesRepository';

let mockParams: Record<string, string> = {};
let mockRecorderProps: any = null;
const mockBack = jest.fn();
const mockEnroll = jest.fn();
const mockReenroll = jest.fn();
// What the database holds; the store may not have loaded it yet.
let mockSavedProfiles: any[] = [];
const mockState = {
  voiceProfiles: [] as any[],
  loadVoiceProfiles: jest.fn(),
  enrollVoiceProfile: mockEnroll,
  reenrollVoiceProfile: mockReenroll,
  relabelMeetingSpeakers: jest.fn(),
  isDiarizerModelReady: jest.fn(async () => true),
  isDiarizerModelDownloading: jest.fn(() => false),
  downloadDiarizerModel: jest.fn(async () => undefined),
};

jest.mock('@/components/ui/Text', () => ({ Text: require('react-native').Text }));
jest.mock('@/components/ui/Button', () => ({
  Button: ({ onPress, children }: any) =>
    require('react').createElement(require('react-native').Text, { onPress }, children),
}));
jest.mock('expo-router', () => ({
  useLocalSearchParams: () => mockParams,
  useRouter: () => ({ back: mockBack, canGoBack: () => true, replace: jest.fn() }),
}));
jest.mock('@/store/useNotesStore', () => ({
  useNotesStore: (selector: (state: typeof mockState) => unknown) => selector(mockState),
}));
jest.mock('@/data/local/notesRepository', () => ({
  SpeakerProfileOwnerAlreadyExistsError: class extends Error {},
}));
jest.mock('@/data', () => ({
  notesRepository: { getSpeakerProfiles: () => mockSavedProfiles },
}));
jest.mock('@/components/notes/VoiceEnrollmentRecorder', () => ({
  VoiceEnrollmentRecorder: (props: any) => {
    mockRecorderProps = props;
    return null;
  },
}));

beforeEach(() => {
  jest.clearAllMocks();
  mockParams = {};
  mockRecorderProps = null;
  mockState.voiceProfiles = [];
  mockSavedProfiles = [];
  mockState.loadVoiceProfiles.mockImplementation(() => {
    mockState.voiceProfiles = mockSavedProfiles;
  });
});

describe('VoiceEnrollmentScreen', () => {
  it('teaches your own voice by default', () => {
    mockParams = { owner: '1' };
    const { getByText } = render(<VoiceEnrollmentScreen />);
    expect(getByText('Teach OpenWhispr Your Voice')).toBeTruthy();
    expect(mockRecorderProps).toMatchObject({ isOwner: true, profileId: undefined });
  });

  it("adds someone else's voice", () => {
    mockParams = { owner: '0' };
    const { getByText } = render(<VoiceEnrollmentScreen />);
    expect(getByText("Add Someone's Voice")).toBeTruthy();
    expect(mockRecorderProps).toMatchObject({ isOwner: false, profileId: undefined });
  });

  it('retrains an existing profile, keeping it', async () => {
    mockParams = { profileId: '2' };
    mockSavedProfiles = [{ id: 2, displayName: 'Me', isOwner: 1 }];
    mockState.voiceProfiles = mockSavedProfiles;
    mockReenroll.mockResolvedValueOnce({ id: 2 });
    const { getByText } = render(<VoiceEnrollmentScreen />);
    expect(getByText('Retrain Your Voice')).toBeTruthy();
    expect(mockRecorderProps).toMatchObject({ isOwner: true, profileId: 2 });

    await mockRecorderProps.onSubmit({ consentAccepted: true });

    expect(mockReenroll).toHaveBeenCalledWith(expect.objectContaining({ profileId: 2 }));
    expect(mockEnroll).not.toHaveBeenCalled();
  });

  it('retrains your existing profile instead of starting a read that would be refused', () => {
    mockParams = { owner: '1' };
    // Not loaded into the store yet, as when you come straight from a meeting.
    mockSavedProfiles = [{ id: 4, displayName: 'Me', isOwner: 1 }];
    const { getByText } = render(<VoiceEnrollmentScreen />);
    expect(getByText('Retrain Your Voice')).toBeTruthy();
    expect(mockRecorderProps).toMatchObject({ isOwner: true, profileId: 4 });
  });

  it('shows a profile that loads after the first render', () => {
    mockParams = { profileId: '2' };
    mockSavedProfiles = [{ id: 2, displayName: 'Alice', isOwner: 0 }];
    const { getByText } = render(<VoiceEnrollmentScreen />);
    expect(getByText("Retrain Alice's Voice")).toBeTruthy();
    expect(mockRecorderProps).toMatchObject({ isOwner: false, profileId: 2 });
  });

  it('says so and offers Back when the profile was deleted', () => {
    mockParams = { profileId: '2' };
    const { getByTestId, getByText } = render(<VoiceEnrollmentScreen />);
    expect(getByTestId('voice-enrollment-missing')).toBeTruthy();
    expect(mockRecorderProps).toBeNull();
    fireEvent.press(getByText('Back'));
    expect(mockBack).toHaveBeenCalled();
  });

  it('labels the meeting it was opened from once your voice is saved', async () => {
    mockParams = { owner: '1', noteId: '7' };
    mockEnroll.mockResolvedValueOnce({ id: 3 });
    render(<VoiceEnrollmentScreen />);

    await mockRecorderProps.onSubmit({});

    expect(mockState.relabelMeetingSpeakers).toHaveBeenCalledWith(7, 3);
  });

  it('reloads profiles when the one being retrained was deleted, so the screen says it is gone', async () => {
    const { VOICE_ENROLLMENT_PROFILE_NOT_FOUND, VoiceEnrollmentError } = jest.requireActual(
      '@/services/diarization/VoiceprintService',
    );
    mockParams = { profileId: '2' };
    mockSavedProfiles = [{ id: 2, displayName: 'Alice', isOwner: 0 }];
    render(<VoiceEnrollmentScreen />);
    mockSavedProfiles = [];
    mockReenroll.mockRejectedValueOnce(
      new VoiceEnrollmentError(VOICE_ENROLLMENT_PROFILE_NOT_FOUND, 'gone'),
    );

    await expect(mockRecorderProps.onSubmit({})).rejects.toBeInstanceOf(VoiceEnrollmentError);

    expect(mockState.loadVoiceProfiles).toHaveBeenCalledTimes(2);
  });

  it('goes back once when Done is tapped twice', () => {
    mockParams = { owner: '1' };
    render(<VoiceEnrollmentScreen />);

    mockRecorderProps.onDone();
    mockRecorderProps.onDone();

    expect(mockBack).toHaveBeenCalledTimes(1);
  });

  it('explains when you already taught it your voice', async () => {
    const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
    mockParams = { owner: '1' };
    mockEnroll.mockRejectedValueOnce(new SpeakerProfileOwnerAlreadyExistsError());
    render(<VoiceEnrollmentScreen />);

    await expect(mockRecorderProps.onSubmit({})).rejects.toBeInstanceOf(
      SpeakerProfileOwnerAlreadyExistsError,
    );
    await waitFor(() =>
      expect(alertSpy).toHaveBeenCalledWith(
        "You've already taught OpenWhispr your voice",
        'Open it in Voice Profiles and choose Retrain Voice.',
      ),
    );
    // Reading again would only be refused again.
    expect(mockBack).toHaveBeenCalled();
    expect(mockState.relabelMeetingSpeakers).not.toHaveBeenCalled();
    alertSpy.mockRestore();
  });
});

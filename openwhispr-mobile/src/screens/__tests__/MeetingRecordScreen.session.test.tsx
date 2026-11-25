import { useState } from 'react';
import type React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import {
  MeetingSessionProvider,
  useMeetingSession,
  type MeetingSession,
} from '@/components/notes/MeetingSessionProvider';
import { MeetingRecordScreen } from '../MeetingRecordScreen';

// The real provider around the real screen: only the recorders and the store are faked, so
// leaving the screen is checked against the session that actually owns the meeting.

const mockNotesState = {
  notes: [] as { id: number; content: string; transcriptionStatus: string }[],
  createMeetingNote: jest.fn(),
  updateNote: jest.fn(),
  transitionStatus: jest.fn(),
  runMeetingPipeline: jest.fn(),
  finalizeCloudMeeting: jest.fn(),
  appendCloudMeetingUtterance: jest.fn(),
  isDiarizerAvailable: jest.fn(async () => true),
  isDiarizerModelReady: jest.fn(async () => true),
  isLocalAsrModelReady: jest.fn(async () => true),
  downloadDiarizerModel: jest.fn(async () => undefined),
};
jest.mock('@/store/useNotesStore', () => {
  const useNotesStore = (selector?: (state: unknown) => unknown): unknown =>
    selector ? selector(mockNotesState) : mockNotesState;
  useNotesStore.getState = (): unknown => mockNotesState;
  return { useNotesStore };
});

const mockRecording = {
  startRecording: jest.fn(),
  stopRecordingRaw: jest.fn(),
  cancelRecording: jest.fn(),
  canResumeRecording: jest.fn(() => true),
  audioRecorder: null,
};
jest.mock('@/hooks/useAudioRecording', () => ({
  useAudioRecording: () => mockRecording,
}));

const mockUtterances = [{ text: 'We ship on Friday', startMs: 0, endMs: 1200 }];
const mockCloud = {
  status: 'live',
  error: null,
  partialText: 'and then',
  utterances: mockUtterances,
  capturedSeconds: 12,
  droppedSeconds: 0,
  interruptions: 0,
  reconnects: 0,
  liveSinceMs: 1000,
  stop: jest.fn(),
};
const mockUseCloudMeeting = jest.fn((_options: { enabled: boolean }) => mockCloud);
jest.mock('@/hooks/useCloudMeeting', () => ({
  useCloudMeeting: (options: { enabled: boolean }) => mockUseCloudMeeting(options),
}));
jest.mock('@/hooks/useMeetingRecorderHealth', () => ({
  useMeetingRecorderHealth: () => ({ capturing: true, capturedMs: 5000 }),
}));
jest.mock('@/hooks/useMeetingLiveActivity', () => ({ useMeetingLiveActivity: jest.fn() }));
jest.mock('@/lib/meetingCaptureAlerts', () => ({
  alertCloudMeetingCapture: jest.fn(),
  alertIfPartialCapture: jest.fn(),
  useCapturePausedNotification: jest.fn(),
}));
jest.mock('@/lib/meetingCaptureTelemetry', () => ({
  reportCaptureInterrupted: jest.fn(),
  reportMeetingFinished: jest.fn(),
}));
jest.mock('@/data', () => ({ notesRepository: { updateNoteMeta: jest.fn() } }));
jest.mock('expo-file-system/legacy', () => ({
  documentDirectory: 'file:///docs/',
  copyAsync: jest.fn(),
  deleteAsync: jest.fn(),
}));
jest.mock('@/lib/transcriptAudio', () => ({
  excludeMeetingFileFromBackup: jest.fn(() => Promise.resolve()),
  meetingRecordingUri: (noteId: number) => `file:///docs/meeting-audio/${noteId}.wav`,
}));
jest.mock('@/lib/sentry', () => ({
  Sentry: { captureException: jest.fn(), captureMessage: jest.fn() },
}));
jest.mock('@/lib/transcriptionLanguage', () => ({ getPreferredTranscriptionLanguage: () => 'en' }));

let mockCloudRecordingProps: Record<string, unknown> | null = null;
jest.mock('expo-router', () => ({
  router: { replace: jest.fn(), back: jest.fn() },
  useLocalSearchParams: () => ({}),
  useFocusEffect: (effect: () => (() => void) | void) =>
    require('react').useEffect(effect, [effect]),
}));
jest.mock('@react-navigation/elements', () => ({ useHeaderHeight: () => 0 }));
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
jest.mock('@/hooks/useKeyboardHeight', () => ({ useKeyboardHeight: () => 0 }));
jest.mock('@/components/ui/Text', () => ({ Text: require('react-native').Text }));
jest.mock('@/components/ui/Button', () => ({
  Button: ({ onPress, children }: { onPress: () => void; children: unknown }) =>
    require('react').createElement(require('react-native').Text, { onPress }, children),
}));
jest.mock('@/components/features/WaveformVisualizer', () => ({ ProcessingWaveform: () => null }));
jest.mock('@/components/notes/CalendarEventPicker', () => ({ CalendarEventPicker: () => null }));
jest.mock('@/components/notes/SpeakerCountPrompt', () => ({
  SpeakerCountPrompt: ({ onSubmit }: { onSubmit: (n: number | undefined) => void }) =>
    require('react').createElement(
      require('react-native').Text,
      { testID: 'speaker-count-submit', onPress: () => onSubmit(3) },
      'How many people?',
    ),
}));
jest.mock('@/components/notes/CloudMeetingRecording', () => ({
  CloudMeetingRecording: (props: Record<string, unknown>) => {
    mockCloudRecordingProps = props;
    return require('react').createElement(
      require('react-native').Text,
      { testID: 'cloud-recording' },
      'Live',
    );
  },
}));
jest.mock('@/config/colors', () => ({ BRAND: '#000', iosColor: () => '#000' }));
jest.mock('@/data/calendarRepository', () => ({ calendarRepository: {} }));
jest.mock('@/lib/calendar/meetingContext', () => ({ buildCalendarMeetingContext: jest.fn() }));
jest.mock('@/lib/calendar/meetingSuggestions', () => ({
  getMeetingCalendarEventSuggestions: () => [],
}));
const mockCalendarState = { accounts: [], load: jest.fn(async () => undefined) };
jest.mock('@/store/useGoogleCalendarStore', () => ({
  useGoogleCalendarStore: (selector: (state: unknown) => unknown) => selector(mockCalendarState),
}));
jest.mock('@/store/useAuthStore', () => {
  const state = { user: { id: 'member' } };
  const useAuthStore = (selector: (value: typeof state) => unknown): unknown => selector(state);
  useAuthStore.getState = (): typeof state => state;
  return { useAuthStore };
});
jest.mock('@/store/useProcessingModeStore', () => ({
  useProcessingModeStore: { getState: () => ({ activeMode: 'cloud' }) },
}));
// Signed in and not private: the screen takes the cloud realtime path.
jest.mock('@/lib/accountAccess', () => ({ canRunCloudMeeting: () => true }));
jest.mock('@/lib/superwall', () => ({
  SUPERWALL_PLACEMENTS: { meetingRecordStart: 'meeting_record_start' },
}));

let session: MeetingSession;
const Probe = (): null => {
  session = useMeetingSession();
  return null;
};

// Stands in for navigation: the screen comes and goes while the provider stays mounted.
let setScreenShown: (shown: boolean) => void = () => undefined;
const App = (): React.JSX.Element => {
  const [shown, setShown] = useState(true);
  setScreenShown = setShown;
  return (
    <MeetingSessionProvider>
      <Probe />
      {shown ? <MeetingRecordScreen /> : null}
    </MeetingSessionProvider>
  );
};

beforeEach(() => {
  jest.clearAllMocks();
  mockCloudRecordingProps = null;
  mockNotesState.notes = [];
  mockNotesState.createMeetingNote.mockImplementation(() => {
    const note = { id: 42, content: '', transcriptionStatus: 'recording' };
    mockNotesState.notes = [note];
    return note;
  });
});

describe('MeetingRecordScreen with the real session', () => {
  it('leaving the screen keeps the cloud meeting running, and coming back shows it', () => {
    render(<App />);
    fireEvent.press(screen.getByTestId('speaker-count-submit'));

    expect(session.phase).toBe('cloud-recording');
    expect(mockNotesState.createMeetingNote).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('cloud-recording')).toBeTruthy();

    act(() => setScreenShown(false));
    mockUseCloudMeeting.mockClear();
    // Anything that re-renders the provider after the screen left.
    act(() => session.setRawNotes('Decisions'));

    expect(screen.queryByTestId('cloud-recording')).toBeNull();
    expect(session.phase).toBe('cloud-recording');
    expect(session.noteId).toBe(42);
    expect(mockUseCloudMeeting).toHaveBeenCalled();
    expect(mockUseCloudMeeting.mock.calls.every(([options]) => options.enabled)).toBe(true);
    expect(mockCloud.stop).not.toHaveBeenCalled();
    expect(mockNotesState.finalizeCloudMeeting).not.toHaveBeenCalled();
    expect(mockNotesState.transitionStatus).not.toHaveBeenCalled();

    mockCloudRecordingProps = null;
    act(() => setScreenShown(true));

    expect(screen.getByTestId('cloud-recording')).toBeTruthy();
    expect(screen.queryByTestId('speaker-count-submit')).toBeNull();
    expect(mockCloudRecordingProps).toMatchObject({
      utterances: mockUtterances,
      partialText: 'and then',
      rawNotes: 'Decisions',
    });
    expect(mockNotesState.createMeetingNote).toHaveBeenCalledTimes(1);
  });
});

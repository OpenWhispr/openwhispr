import { StrictMode, useState } from 'react';
import type React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { router } from 'expo-router';
import type { MeetingSession } from '@/components/notes/MeetingSessionProvider';
import type { RegisterSuperwallGateOptions } from '@/hooks/useSuperwallGate';
import { MeetingRecordScreen } from '../MeetingRecordScreen';

let mockParams: Record<string, string> = {};
let mockCloudRecordingProps: Record<string, unknown> | null = null;
let mockRegisteredGate: RegisterSuperwallGateOptions | null = null;

const createSession = (overrides: Partial<MeetingSession> = {}): MeetingSession => ({
  phase: 'idle',
  path: 'local',
  noteId: null,
  title: null,
  expectedSpeakerCount: undefined,
  capturing: false,
  capturedSeconds: 0,
  starting: false,
  cloud: { status: 'connecting', error: null, utterances: [], partialText: '', liveSinceMs: null },
  rawNotes: '',
  setRawNotes: jest.fn(),
  startLocal: jest.fn(async () => true),
  startCloud: jest.fn(() => true),
  stop: jest.fn(async () => undefined),
  finishedNoteId: null,
  acknowledgeFinished: jest.fn(),
  ...overrides,
});
let mockSession: MeetingSession = createSession();

jest.mock('@/components/notes/MeetingSessionProvider', () => ({
  useMeetingSession: () => mockSession,
}));

const mockNotesState = {
  isDiarizerAvailable: jest.fn(async () => true),
  isDiarizerModelReady: jest.fn(async () => true),
  isLocalAsrModelReady: jest.fn(async () => true),
  downloadDiarizerModel: jest.fn(async () => undefined),
};
jest.mock('@/store/useNotesStore', () => ({
  useNotesStore: (selector: (state: typeof mockNotesState) => unknown) => selector(mockNotesState),
}));

// Focus runs on mount, as in a navigator; the tests call blurScreen/focusScreen to leave and return.
let mockFocusEffect: (() => (() => void) | void) | null = null;
let mockFocusCleanup: (() => void) | void;
jest.mock('expo-router', () => ({
  router: { replace: jest.fn(), back: jest.fn() },
  useLocalSearchParams: () => mockParams,
  useFocusEffect: (effect: () => (() => void) | void) => {
    require('react').useEffect(() => {
      mockFocusEffect = effect;
      mockFocusCleanup = effect();
      return () => mockFocusCleanup?.();
    }, [effect]);
  },
}));
const blurScreen = (): void => {
  act(() => {
    mockFocusCleanup?.();
    mockFocusCleanup = undefined;
  });
};
const focusScreen = (): void => {
  act(() => {
    mockFocusCleanup = mockFocusEffect?.();
  });
};
jest.mock('@react-navigation/elements', () => ({ useHeaderHeight: () => 0 }));
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
jest.mock('@/hooks/useKeyboardHeight', () => ({ useKeyboardHeight: () => 0 }));
jest.mock('@/components/ui/Text', () => ({ Text: require('react-native').Text }));
jest.mock('@/components/ui/Button', () => ({
  Button: ({
    onPress,
    children,
    testID,
  }: {
    onPress: () => void;
    children: unknown;
    testID?: string;
  }) => require('react').createElement(require('react-native').Text, { onPress, testID }, children),
}));
jest.mock('@/components/features/WaveformVisualizer', () => ({ ProcessingWaveform: () => null }));
jest.mock('@/components/notes/CalendarEventPicker', () => ({ CalendarEventPicker: () => null }));
jest.mock('@/components/notes/SpeakerCountPrompt', () => ({
  SpeakerCountPrompt: ({ onSubmit }: { onSubmit: (n: number | undefined) => void }) =>
    require('react').createElement(
      require('react-native').Text,
      { testID: 'speaker-count-submit', onPress: () => onSubmit(2) },
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
// One state object, as the real store returns: a fresh accounts array each render would re-run
// the calendar effect forever.
const mockCalendarState = { accounts: [], load: jest.fn(async () => undefined) };
jest.mock('@/store/useGoogleCalendarStore', () => ({
  useGoogleCalendarStore: (selector: (state: unknown) => unknown) => selector(mockCalendarState),
}));
jest.mock('@/hooks/useSuperwallGate', () => ({
  useSuperwallGate: () => ({
    register: async (options: RegisterSuperwallGateOptions) => {
      mockRegisteredGate = options;
      return true;
    },
  }),
}));
jest.mock('@/store/useAuthStore', () => ({
  useAuthStore: { getState: () => ({ user: null }) },
}));
jest.mock('@/store/useProcessingModeStore', () => ({
  useProcessingModeStore: { getState: () => ({ activeMode: 'private' }) },
}));
let mockCloudMeeting = false;
jest.mock('@/lib/accountAccess', () => ({ canRunCloudMeeting: () => mockCloudMeeting }));
jest.mock('@/lib/sentry', () => ({ Sentry: { captureException: jest.fn() } }));
jest.mock('@/lib/superwall', () => ({
  SUPERWALL_PLACEMENTS: { meetingRecordStart: 'meeting_record_start' },
}));

// Re-renders the screen when the mocked session changes, as the provider's context would.
let mockRerender: () => void = () => undefined;
const Harness = (): React.JSX.Element => {
  const [, setTick] = useState(0);
  mockRerender = () => setTick((tick) => tick + 1);
  return <MeetingRecordScreen />;
};
const setSessionAndRerender = (next: MeetingSession): void => {
  mockSession = next;
  mockRerender();
};

const flush = async (): Promise<void> => {
  await act(async () => {
    await Promise.resolve();
  });
};

beforeEach(() => {
  jest.clearAllMocks();
  mockParams = {};
  mockCloudRecordingProps = null;
  mockRegisteredGate = null;
  mockCloudMeeting = false;
  mockSession = createSession();
  mockNotesState.isDiarizerModelReady.mockResolvedValue(true);
});

describe('MeetingRecordScreen', () => {
  it('unmounting during cloud-recording does not stop the session', () => {
    mockSession = createSession({ phase: 'cloud-recording', path: 'cloud', noteId: 5 });
    const { unmount } = render(<MeetingRecordScreen />);
    expect(screen.getByTestId('cloud-recording')).toBeTruthy();

    unmount();

    expect(mockSession.stop).not.toHaveBeenCalled();
  });

  it('mounting while a meeting is active shows the recording UI with existing utterances and starts nothing', async () => {
    mockParams = { folderId: '3', spaceId: '4' };
    const utterances = [{ text: 'Hello there', startMs: 0, endMs: 900 }];
    mockSession = createSession({
      phase: 'cloud-recording',
      path: 'cloud',
      noteId: 5,
      capturing: true,
      capturedSeconds: 42,
      rawNotes: 'Draft',
      cloud: {
        status: 'live',
        error: null,
        utterances: utterances as MeetingSession['cloud']['utterances'],
        partialText: 'and then',
        liveSinceMs: 1000,
      },
    });

    render(<MeetingRecordScreen />);
    await flush();

    expect(screen.queryByTestId('speaker-count-submit')).toBeNull();
    expect(mockCloudRecordingProps).toMatchObject({
      utterances,
      partialText: 'and then',
      capturedSeconds: 42,
      rawNotes: 'Draft',
      captureStarted: true,
    });
    expect(mockSession.startLocal).not.toHaveBeenCalled();
    expect(mockSession.startCloud).not.toHaveBeenCalled();
  });

  it('replaces to the note when finishedNoteId is set', () => {
    mockSession = createSession({ phase: 'processing', path: 'local', noteId: 42 });
    render(
      <StrictMode>
        <Harness />
      </StrictMode>,
    );
    expect(router.replace).not.toHaveBeenCalled();

    // The provider returns to idle in the same update that reports the finished note, and
    // acknowledging clears it again, as the real provider does.
    act(() => {
      setSessionAndRerender(
        createSession({
          phase: 'idle',
          finishedNoteId: 42,
          acknowledgeFinished: jest.fn(() => {
            setSessionAndRerender({ ...mockSession, finishedNoteId: null });
          }),
        }),
      );
    });

    expect(router.replace).toHaveBeenCalledTimes(1);
    expect(router.replace).toHaveBeenCalledWith('/(tabs)/(notes)/42');
    expect(mockSession.finishedNoteId).toBeNull();
    // Still the processing view after the acknowledgement, not a flash of the start prompt.
    expect(screen.queryByTestId('speaker-count-submit')).toBeNull();
    expect(screen.getByText('Preparing meeting notes…')).toBeTruthy();
    expect(mockCalendarState.load).not.toHaveBeenCalled();
  });

  it('a finish that happened while the screen was closed is acknowledged without navigating and the prompt is shown', () => {
    const acknowledgeFinished = jest.fn(() => {
      setSessionAndRerender({ ...mockSession, finishedNoteId: null });
    });
    mockSession = createSession({ phase: 'idle', finishedNoteId: 17, acknowledgeFinished });
    render(
      <StrictMode>
        <Harness />
      </StrictMode>,
    );

    expect(acknowledgeFinished).toHaveBeenCalled();
    expect(router.replace).not.toHaveBeenCalled();
    expect(screen.getByTestId('speaker-count-submit')).toBeTruthy();
    expect(screen.queryByText('Preparing meeting notes…')).toBeNull();
  });

  it('returning to a screen that already handed off shows the prompt again, not processing', () => {
    mockSession = createSession({ phase: 'processing', path: 'local', noteId: 42 });
    render(
      <StrictMode>
        <Harness />
      </StrictMode>,
    );
    act(() => {
      setSessionAndRerender(
        createSession({
          phase: 'idle',
          finishedNoteId: 42,
          acknowledgeFinished: jest.fn(() => {
            setSessionAndRerender({ ...mockSession, finishedNoteId: null });
          }),
        }),
      );
    });
    expect(screen.getByText('Preparing meeting notes…')).toBeTruthy();

    // The replace didn't remove this screen; the user leaves it and comes back.
    blurScreen();
    focusScreen();

    expect(screen.getByTestId('speaker-count-submit')).toBeTruthy();
    expect(screen.queryByText('Preparing meeting notes…')).toBeNull();
    expect(router.replace).toHaveBeenCalledTimes(1);
  });

  it('a finish while the screen is mounted but not focused does not navigate', () => {
    mockSession = createSession({ phase: 'processing', path: 'local', noteId: 42 });
    render(
      <StrictMode>
        <Harness />
      </StrictMode>,
    );
    // The user went to another tab; this screen stays mounted in the Notes stack.
    blurScreen();
    const acknowledgeFinished = jest.fn(() => {
      setSessionAndRerender({ ...mockSession, finishedNoteId: null });
    });
    act(() => {
      setSessionAndRerender(
        createSession({ phase: 'idle', finishedNoteId: 42, acknowledgeFinished }),
      );
    });
    expect(acknowledgeFinished).toHaveBeenCalled();
    expect(router.replace).not.toHaveBeenCalled();

    // Coming back shows the normal start prompt.
    focusScreen();
    expect(screen.getByTestId('speaker-count-submit')).toBeTruthy();
    expect(screen.queryByText('Preparing meeting notes…')).toBeNull();
  });

  it('a new meeting after a hand-off is shown, and its failure lands on the prompt', () => {
    mockSession = createSession({ phase: 'processing', path: 'local', noteId: 42 });
    render(<Harness />);
    act(() => {
      setSessionAndRerender(
        createSession({
          phase: 'idle',
          finishedNoteId: 42,
          acknowledgeFinished: jest.fn(() => {
            setSessionAndRerender({ ...mockSession, finishedNoteId: null });
          }),
        }),
      );
    });

    act(() => setSessionAndRerender(createSession({ phase: 'cloud-recording', path: 'cloud' })));
    expect(screen.getByTestId('cloud-recording')).toBeTruthy();
    act(() => setSessionAndRerender(createSession({ phase: 'idle' })));

    expect(screen.getByTestId('speaker-count-submit')).toBeTruthy();
    expect(router.replace).toHaveBeenCalledTimes(1);
  });

  it('after acknowledging a stale finish, a new finish while mounted navigates once', () => {
    mockSession = createSession({
      phase: 'idle',
      finishedNoteId: 17,
      acknowledgeFinished: jest.fn(() => {
        setSessionAndRerender({ ...mockSession, finishedNoteId: null });
      }),
    });
    render(
      <StrictMode>
        <Harness />
      </StrictMode>,
    );
    expect(router.replace).not.toHaveBeenCalled();
    expect(screen.getByTestId('speaker-count-submit')).toBeTruthy();

    act(() => {
      setSessionAndRerender(
        createSession({
          phase: 'idle',
          finishedNoteId: 18,
          acknowledgeFinished: jest.fn(() => {
            setSessionAndRerender({ ...mockSession, finishedNoteId: null });
          }),
        }),
      );
    });

    expect(router.replace).toHaveBeenCalledTimes(1);
    expect(router.replace).toHaveBeenCalledWith('/(tabs)/(notes)/18');
    expect(screen.getByText('Preparing meeting notes…')).toBeTruthy();
  });

  it('shows a starting state instead of the prompt while the session waits for the recorder', () => {
    mockSession = createSession({ phase: 'idle', starting: true });
    render(<MeetingRecordScreen />);

    expect(screen.queryByTestId('speaker-count-submit')).toBeNull();
    expect(screen.getByText('Starting recording…')).toBeTruthy();
  });

  it('does not start after unmount when the model download resolves', async () => {
    mockNotesState.isDiarizerModelReady.mockResolvedValue(false);
    let resolveDownload: () => void = () => undefined;
    mockNotesState.downloadDiarizerModel.mockImplementation(
      () =>
        new Promise<undefined>((resolve) => {
          resolveDownload = () => resolve(undefined);
        }),
    );
    const { unmount } = render(<MeetingRecordScreen />);

    fireEvent.press(screen.getByTestId('speaker-count-submit'));
    await flush();
    await flush();
    fireEvent.press(screen.getByTestId('model-download'));
    await flush();
    expect(mockNotesState.downloadDiarizerModel).toHaveBeenCalled();

    unmount();
    await act(async () => {
      resolveDownload();
      await Promise.resolve();
    });

    expect(mockSession.startLocal).not.toHaveBeenCalled();
  });

  it('does not start when the paywall lets the meeting through after unmount', async () => {
    const { unmount } = render(<MeetingRecordScreen />);

    fireEvent.press(screen.getByTestId('speaker-count-submit'));
    await flush();
    await flush();
    expect(mockRegisteredGate).not.toBeNull();

    unmount();
    mockRegisteredGate?.feature?.();
    await flush();

    expect(mockSession.startLocal).not.toHaveBeenCalled();
  });

  it('starts a local meeting with the screen-built input once the gate passes', async () => {
    mockParams = { folderId: '3', spaceId: '4' };
    render(<MeetingRecordScreen />);

    fireEvent.press(screen.getByTestId('speaker-count-submit'));
    await flush();
    await flush();
    mockRegisteredGate?.feature?.();
    await flush();

    expect(mockSession.startLocal).toHaveBeenCalledWith({
      expectedSpeakerCount: 2,
      folderId: 3,
      spaceId: 4,
      context: null,
    });
  });

  it('starts a cloud meeting through the session', async () => {
    mockCloudMeeting = true;
    render(<MeetingRecordScreen />);

    fireEvent.press(screen.getByTestId('speaker-count-submit'));
    await flush();

    expect(mockSession.startCloud).toHaveBeenCalledWith({
      expectedSpeakerCount: 2,
      folderId: undefined,
      spaceId: undefined,
      context: null,
    });
    expect(mockSession.startLocal).not.toHaveBeenCalled();
  });
});

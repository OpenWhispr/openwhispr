import React from 'react';
import { Platform, Alert, PermissionsAndroid } from 'react-native';
import { act, fireEvent, render } from '@testing-library/react-native';
import { MeetingRecordScreen as IOSMeetingRecordScreen } from '../MeetingRecordScreen';
import { MeetingRecordScreen as AndroidMeetingRecordScreen } from '../MeetingRecordScreen.android';
const MeetingRecordScreen = () =>
  Platform.OS === 'android' ? <AndroidMeetingRecordScreen /> : <IOSMeetingRecordScreen />;
import { CloudMeetingFinishError } from '@/hooks/useCloudMeeting.android';

const mockCreateNote = jest.fn(() => ({ id: 7, content: '' }));
const mockFinalize = jest.fn(async () => undefined);
const mockReplace = jest.fn();
const mockLocalStart = jest.fn(async (): Promise<void> => undefined);
const mockCancelLocal = jest.fn(async () => undefined);
const mockStopCloud = jest.fn();
const mockRegisterGate = jest.fn();
const mockStopLocalRaw = jest.fn(async (): Promise<string | null> => 'file:///temporary.wav');
const mockCopy = jest.fn<Promise<void>, [{ from: string; to: string }]>(async () => undefined);
const mockStopIOSCloud = jest.fn(() => mockParts);
let mockIOSCloudStatus = 'live';
const mockRealtimeStart = jest.fn();
let mockUseRealCloudHook = false;
const mockParts = [{ itemId: 'kept', text: 'Captured meeting text.', startMs: 0, endMs: 1000 }];
const mockNotes = {
  createMeetingNote: mockCreateNote,
  finalizeCloudMeeting: mockFinalize,
  updateNote: jest.fn(),
  transitionStatus: jest.fn(),
  runMeetingPipeline: jest.fn(),
  isDiarizerAvailable: jest.fn(async () => true),
  isLocalAsrModelReady: jest.fn(async () => true),
  isDiarizerModelReady: jest.fn(async () => true),
  downloadDiarizerModel: jest.fn(),
  notes: [{ id: 7, transcriptionStatus: 'recording' }],
};
const mockLoadCalendars = jest.fn(async () => undefined);
const mockAccounts: unknown[] = [];
let mockUser = { id: 'a' };
let mockMode = 'cloud';
let mockFeature: (() => void) | undefined;
let mockBlur: (() => void) | undefined;
let mockAuthListener: ((state: unknown, previous: unknown) => void) | undefined;
let mockModeListener: ((state: unknown, previous: unknown) => void) | undefined;
let mockParams = { folderId: '2' };

const mockCancelDownload = jest.fn(async (_id: string) => undefined);
jest.mock('@/android/models', () => ({
  cancelAndroidDownload: (id: string) => mockCancelDownload(id),
}));
const mockDurableStart = jest.fn(async (): Promise<void> => undefined);
const mockDurableStop = jest.fn(async () => 'file:///app/documents/meeting-7.wav');
let mockNativeStopped: ((error?: Error) => void) | undefined;
let mockOwnerValid = true;
let mockUseRealLocalContext = false;
const mockAuthListeners = new Set<(state: unknown, previous: unknown) => void>();
let mockSavedNote = {
  id: 7,
  clientNoteId: 'local-a7',
  createdAt: '2026-10-23 13:00:00',
  noteType: 'meeting',
  isPrivate: 1,
  deletedAt: null,
  sourceFile: 'file:///app/documents/meeting-7.wav',
  transcriptionStatus: 'recording',
};
jest.mock('@/android/LocalMeetingRecorder', () => ({
  LocalMeetingRecorder: jest.fn().mockImplementation((_id, onStopped) => {
    mockNativeStopped = onStopped;
    return {
      uri: 'file:///app/documents/meeting-7.wav',
      start: mockDurableStart,
      stop: mockDurableStop,
    };
  }),
}));
jest.mock('@/android/localMeetingContext', () => ({
  createLocalMeetingContext: (_id: number, signal: AbortSignal) =>
    mockUseRealLocalContext
      ? jest.requireActual('@/android/localMeetingContext').createLocalMeetingContext(_id, signal)
      : {
          signal,
          ownsNote: () => mockOwnerValid,
          ownsSavedNote: () => mockOwnerValid,
          recoverInterruptedNoteWhenOwnerReturns: jest.fn(),
          checkpoint: () => {
            if (!mockOwnerValid || signal.aborted)
              throw Object.assign(new Error('Cancelled'), { name: 'AbortError' });
          },
          dispose: jest.fn(),
        },
}));

jest.mock('expo-router', () => ({
  router: { replace: (...args: unknown[]) => mockReplace(...args), back: jest.fn() },
  useLocalSearchParams: () => mockParams,
  useFocusEffect: (callback: () => () => void) => {
    require('react').useEffect(() => {
      mockBlur = callback();
      return mockBlur;
    }, [callback]);
  },
}));
jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
jest.mock('@react-navigation/native', () => ({ usePreventRemove: jest.fn() }));
jest.mock('@react-navigation/elements', () => ({ useHeaderHeight: () => 0 }));
jest.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ bottom: 0 }) }));
jest.mock('expo-file-system/legacy', () => ({
  documentDirectory: 'file:///app/documents/',
  copyAsync: (options: { from: string; to: string }) => mockCopy(options),
}));
jest.mock('@/components/ui/Text', () => ({ Text: require('react-native').Text }));
jest.mock('@/components/ui/Button', () => ({ Button: require('react-native').Pressable }));
jest.mock('@/components/features/WaveformVisualizer', () => ({ ProcessingWaveform: () => null }));
jest.mock('@/components/notes/CalendarEventPicker', () => ({ CalendarEventPicker: () => null }));
jest.mock('@/components/notes/SpeakerCountPrompt', () => ({
  SpeakerCountPrompt: ({ onSubmit }: { onSubmit: () => void }) =>
    require('react').createElement(require('react-native').Pressable, {
      testID: 'begin',
      onPress: onSubmit,
    }),
}));
jest.mock('@/android/MeetingSetup', () => ({
  MeetingSetup: ({ onStart }: { onStart: () => void }) =>
    require('react').createElement(require('react-native').Pressable, {
      testID: 'begin',
      onPress: onStart,
    }),
}));
jest.mock('@/components/notes/CloudMeetingRecording', () => ({
  CloudMeetingRecording: ({
    onStop,
    stopLabel,
    error,
  }: {
    onStop: () => void;
    stopLabel?: string;
    error?: string;
  }) =>
    require('react').createElement(
      require('react-native').Pressable,
      { testID: 'stop', onPress: onStop },
      require('react').createElement(
        require('react-native').Text,
        null,
        error ?? stopLabel ?? 'Stop',
      ),
    ),
}));
jest.mock('@/config/colors', () => ({ BRAND: '#222', iosColor: () => '#222' }));
jest.mock('@/data', () => ({
  notesRepository: {
    updateNoteMeta: jest.fn(),
    getNoteById: () => mockSavedNote,
  },
}));
jest.mock('@/data/calendarRepository', () => ({ calendarRepository: {} }));
jest.mock('@/lib/calendar/meetingContext', () => ({ buildCalendarMeetingContext: jest.fn() }));
jest.mock('@/lib/calendar/meetingSuggestions', () => ({
  getMeetingCalendarEventSuggestions: () => [],
}));
jest.mock('@/lib/transcriptionLanguage', () => ({ getPreferredTranscriptionLanguage: () => 'en' }));
jest.mock('@/hooks/useAudioRecording', () => ({
  useAudioRecording: () => ({
    startRecording: mockLocalStart,
    cancelRecording: mockCancelLocal,
    stopRecordingRaw: mockStopLocalRaw,
  }),
}));
jest.mock('@/hooks/useKeyboardHeight', () => ({ useKeyboardHeight: () => 0 }));
jest.mock('@/hooks/useMeetingLiveActivity', () => ({ useMeetingLiveActivity: jest.fn() }));
jest.mock('@/hooks/useSuperwallGate', () => ({
  useSuperwallGate: () => ({
    register: async (options: { feature: () => void }) => {
      mockRegisterGate(options);
      mockFeature = options.feature;
    },
  }),
}));
jest.mock('@/store/useNotesStore', () => ({
  useNotesStore: Object.assign((select: (s: typeof mockNotes) => unknown) => select(mockNotes), {
    getState: () => mockNotes,
  }),
}));
jest.mock('@/store/useGoogleCalendarStore', () => ({
  useGoogleCalendarStore: (select: (s: unknown) => unknown) =>
    select({ accounts: mockAccounts, load: mockLoadCalendars }),
}));
jest.mock('@/store/useAuthStore', () => ({
  useAuthStore: {
    getState: () => ({ user: mockUser }),
    subscribe: (listener: typeof mockAuthListener) => {
      if (listener) mockAuthListeners.add(listener);
      mockAuthListener = (state, previous) => {
        for (const callback of mockAuthListeners) callback(state, previous);
      };
      return () => {
        if (listener) mockAuthListeners.delete(listener);
      };
    },
  },
}));
jest.mock('@/store/useProcessingModeStore', () => ({
  useProcessingModeStore: {
    getState: () => ({ activeMode: mockMode }),
    subscribe: (listener: typeof mockModeListener) => {
      mockModeListener = listener;
      return jest.fn();
    },
  },
}));
jest.mock('@/lib/accountAccess', () => ({
  canRunCloudMeeting: (_user: unknown, mode: string) => mode === 'cloud',
}));
jest.mock('@/lib/sentry', () => ({ Sentry: { captureException: jest.fn() } }));
jest.mock('@/lib/superwall', () => ({ SUPERWALL_PLACEMENTS: { meetingRecordStart: 'meeting' } }));
jest.mock('@/services/transcription/RealtimeMeetingWsService', () => ({
  startRealtimeMeetingWs: (...args: unknown[]) => mockRealtimeStart(...args),
}));
jest.mock('@/hooks/useCloudMeeting', () => ({
  useCloudMeeting: () => ({
    stop: mockStopIOSCloud,
    elapsedSeconds: 2,
    status: mockIOSCloudStatus,
    utterances: mockParts,
  }),
}));
jest.mock('@/hooks/useCloudMeeting.android', () => ({
  ...jest.requireActual('@/hooks/useCloudMeeting.android'),
  useCloudMeeting: (options: unknown) =>
    mockUseRealCloudHook
      ? jest.requireActual('@/hooks/useCloudMeeting.android').useCloudMeeting(options)
      : {
          stop: mockStopCloud,
          cancel: jest.fn(),
          elapsedSeconds: 2,
          status: 'live',
          utterances: mockParts,
          stopRequested: false,
        },
}));

beforeEach(() => {
  jest.clearAllMocks();
  Platform.OS = 'android';
  jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
  jest.spyOn(PermissionsAndroid, 'request').mockResolvedValue(PermissionsAndroid.RESULTS.GRANTED);
  mockOwnerValid = true;
  mockIOSCloudStatus = 'live';
  mockStopIOSCloud.mockReset().mockReturnValue(mockParts);
  mockStopLocalRaw.mockReset().mockResolvedValue('file:///temporary.wav');
  mockCopy.mockReset().mockResolvedValue(undefined);
  mockNotes.isDiarizerAvailable.mockReset().mockResolvedValue(true);
  mockNotes.isLocalAsrModelReady.mockReset().mockResolvedValue(true);
  mockUseRealLocalContext = false;
  mockAuthListeners.clear();
  mockNotes.transitionStatus.mockReset();
  mockNotes.notes = [{ id: 7, transcriptionStatus: 'recording' }];
  mockSavedNote = { ...mockSavedNote, transcriptionStatus: 'recording' };
  mockNativeStopped = undefined;
  mockDurableStart.mockReset().mockResolvedValue(undefined);
  mockDurableStop.mockReset().mockResolvedValue('file:///app/documents/meeting-7.wav');
  mockNotes.runMeetingPipeline.mockReset().mockResolvedValue(undefined);
  mockNotes.isDiarizerModelReady.mockReset().mockResolvedValue(true);
  mockNotes.downloadDiarizerModel.mockReset().mockResolvedValue(undefined);
  mockUser = { id: 'a' };
  mockUseRealCloudHook = false;
  mockMode = 'cloud';
  mockParams = { folderId: '2' };
  mockFeature = undefined;
  mockBlur = undefined;
  mockAuthListener = undefined;
  mockModeListener = undefined;
  mockFinalize.mockReset().mockResolvedValue(undefined);
  mockStopCloud.mockReset().mockResolvedValue(mockParts);
  mockLocalStart.mockReset().mockResolvedValue(undefined);
});
afterEach(() => jest.restoreAllMocks());

it.each([PermissionsAndroid.RESULTS.DENIED, PermissionsAndroid.RESULTS.NEVER_ASK_AGAIN])(
  'keeps cloud meeting setup available without creating a note when microphone access is %s',
  async (result) => {
    jest.mocked(PermissionsAndroid.request).mockResolvedValueOnce(result);
    const view = render(<MeetingRecordScreen />);
    await act(async () => fireEvent.press(view.getByTestId('begin')));
    await act(async () => mockFeature?.());
    expect(mockCreateNote).not.toHaveBeenCalled();
    expect(view.queryByTestId('stop')).toBeNull();
    expect(view.getByTestId('begin')).toBeTruthy();
    expect(Alert.alert).toHaveBeenCalledWith('errorTitle', 'permissionDenied');

    await act(async () => fireEvent.press(view.getByTestId('begin')));
    await act(async () => {
      mockFeature?.();
      mockFeature?.();
    });
    expect(mockCreateNote).toHaveBeenCalledTimes(1);
    expect(view.getByTestId('stop')).toBeTruthy();
  },
);

it('keeps setup usable when the Android permission request fails', async () => {
  jest.mocked(PermissionsAndroid.request).mockRejectedValueOnce(new Error('Activity unavailable'));
  const view = render(<MeetingRecordScreen />);
  await act(async () => fireEvent.press(view.getByTestId('begin')));
  await act(async () => mockFeature?.());
  expect(mockCreateNote).not.toHaveBeenCalled();
  expect(view.getByTestId('begin')).toBeTruthy();
  expect(Alert.alert).toHaveBeenCalledWith('errorTitle', 'permissionDenied');
  await act(async () => fireEvent.press(view.getByTestId('begin')));
  await act(async () => mockFeature?.());
  expect(mockCreateNote).toHaveBeenCalledTimes(1);
});

it.each(['blur', 'unmount', 'account', 'mode', 'destination'] as const)(
  'does not start after a delayed microphone grant following %s',
  async (change) => {
    let grant!: (result: typeof PermissionsAndroid.RESULTS.GRANTED) => void;
    jest.mocked(PermissionsAndroid.request).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          grant = resolve;
        }),
    );
    const view = render(<MeetingRecordScreen />);
    await act(async () => fireEvent.press(view.getByTestId('begin')));
    expect(mockFeature).toBeUndefined();
    act(() => {
      if (change === 'blur') mockBlur?.();
      if (change === 'unmount') view.unmount();
      if (change === 'account') mockAuthListener?.({ user: { id: 'b' } }, { user: mockUser });
      if (change === 'mode') mockModeListener?.({ activeMode: 'private' }, { activeMode: 'cloud' });
      if (change === 'destination') {
        mockParams = { folderId: '3' };
        view.rerender(<MeetingRecordScreen />);
      }
    });
    await act(async () => grant(PermissionsAndroid.RESULTS.GRANTED));
    await act(async () => mockFeature?.());
    expect(mockCreateNote).not.toHaveBeenCalled();
    expect(mockFeature).toBeUndefined();
  },
);

it('does not request Android microphone permission for an iOS cloud meeting', async () => {
  Platform.OS = 'ios';
  const view = render(<MeetingRecordScreen />);
  await act(async () => fireEvent.press(view.getByTestId('begin')));
  await act(async () => mockFeature?.());
  expect(PermissionsAndroid.request).not.toHaveBeenCalled();
  expect(mockCreateNote).toHaveBeenCalledTimes(1);
});

it.each(['blur', 'unmount', 'account', 'mode', 'destination'] as const)(
  'does not start from a late authorization after %s',
  async (change) => {
    const view = render(<MeetingRecordScreen />);
    await act(async () => fireEvent.press(view.getByTestId('begin')));
    expect(mockFeature).toBeDefined();
    act(() => {
      if (change === 'blur') mockBlur?.();
      if (change === 'unmount') view.unmount();
      if (change === 'account') {
        mockAuthListener?.({ user: { id: 'b' } }, { user: mockUser });
        // Switching back must not resurrect the pending authorization.
        mockAuthListener?.({ user: mockUser }, { user: { id: 'b' } });
      }
      if (change === 'mode') {
        mockModeListener?.({ activeMode: 'private' }, { activeMode: 'cloud' });
      }
      if (change === 'destination') {
        mockParams = { folderId: '3' };
        view.rerender(<MeetingRecordScreen />);
      }
    });
    await act(async () => mockFeature?.());
    expect(mockCreateNote).not.toHaveBeenCalled();
    expect(mockLocalStart).not.toHaveBeenCalled();
  },
);

it('consumes a valid start once and persists partial text after finalization fails', async () => {
  mockStopCloud.mockRejectedValue(new CloudMeetingFinishError(new Error('Interrupted'), mockParts));
  const view = render(<MeetingRecordScreen />);
  await act(async () => fireEvent.press(view.getByTestId('begin')));
  await act(async () => {
    mockFeature?.();
    mockFeature?.();
  });
  expect(mockCreateNote).toHaveBeenCalledTimes(1);
  await act(async () => fireEvent.press(view.getByTestId('stop')));
  expect(mockFinalize).toHaveBeenCalledWith(7, mockParts, 2, { incomplete: true });
  expect(mockReplace).toHaveBeenCalledWith('/(tabs)/(notes)/7');
});

it.each([true, false])(
  'retains the recording result when saving fails and retries without recording again (incomplete=%s)',
  async (incomplete) => {
    if (incomplete)
      mockStopCloud.mockRejectedValue(
        new CloudMeetingFinishError(new Error('Interrupted'), mockParts),
      );
    mockFinalize.mockRejectedValueOnce(new Error('database full'));
    const view = render(<MeetingRecordScreen />);
    await act(async () => fireEvent.press(view.getByTestId('begin')));
    await act(async () => mockFeature?.());
    await act(async () => fireEvent.press(view.getByTestId('stop')));
    expect(mockReplace).not.toHaveBeenCalled();
    expect(view.getByText('meetingSaveFailedBody')).toBeTruthy();
    await act(async () => fireEvent.press(view.getByTestId('stop')));
    expect(mockFinalize).toHaveBeenLastCalledWith(7, mockParts, 2, { incomplete });
    expect(mockCreateNote).toHaveBeenCalledTimes(1);
    expect(mockReplace).toHaveBeenCalledWith('/(tabs)/(notes)/7');
  },
);

it('retains upstream iOS local startup after a pending recording resolves', async () => {
  Platform.OS = 'ios';
  mockMode = 'private';
  let resolve!: () => void;
  mockLocalStart.mockImplementation(
    () =>
      new Promise<void>((done) => {
        resolve = done;
      }),
  );
  const view = render(<MeetingRecordScreen />);
  await act(async () => fireEvent.press(view.getByTestId('begin')));
  await act(async () => mockFeature?.());
  expect(mockLocalStart).toHaveBeenCalledTimes(1);
  expect(mockBlur).toBeUndefined();
  act(() => mockBlur?.());
  await act(async () => resolve());
  expect(mockCancelLocal).not.toHaveBeenCalled();
  expect(mockCreateNote).toHaveBeenCalledTimes(1);
});

it('retries repeated save failures with the real hook without reopening microphone capture', async () => {
  mockUseRealCloudHook = true;
  const finish = jest.fn(async () => {
    throw new Error('Interrupted');
  });
  mockRealtimeStart.mockResolvedValue({ stop: jest.fn(), finish, utterances: () => mockParts });
  mockFinalize
    .mockRejectedValueOnce(new Error('database full'))
    .mockRejectedValueOnce(new Error('still full'));
  const view = render(<MeetingRecordScreen />);
  await act(async () => fireEvent.press(view.getByTestId('begin')));
  await act(async () => mockFeature?.());
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await act(async () => fireEvent.press(view.getByTestId('stop')));
    expect(mockRealtimeStart).toHaveBeenCalledTimes(1);
    expect(finish).toHaveBeenCalledTimes(1);
    expect(mockFinalize).toHaveBeenLastCalledWith(7, mockParts, 0, { incomplete: true });
  }
  expect(mockReplace).toHaveBeenCalledWith('/(tabs)/(notes)/7');
});

async function startPrivateMeeting() {
  mockMode = 'private';
  const view = render(<MeetingRecordScreen />);
  await act(async () => fireEvent.press(view.getByTestId('begin')));
  await act(async () => mockFeature?.());
  return view;
}

it('uses durable Android capture and persists its source before processing', async () => {
  const view = await startPrivateMeeting();
  expect(PermissionsAndroid.request).toHaveBeenCalled();
  expect(mockLocalStart).not.toHaveBeenCalled();
  expect(mockDurableStart).toHaveBeenCalledTimes(1);
  expect(require('@/data').notesRepository.updateNoteMeta).toHaveBeenCalledWith(7, {
    sourceFile: 'file:///app/documents/meeting-7.wav',
  });
  await act(async () => fireEvent.press(view.getByTestId('meeting-stop')));
  expect(mockDurableStop).toHaveBeenCalledTimes(1);
  expect(mockNotes.runMeetingPipeline).toHaveBeenCalledWith(
    7,
    'file:///app/documents/meeting-7.wav',
    undefined,
    { signal: expect.any(AbortSignal) },
  );
  expect(mockReplace).toHaveBeenCalledWith('/(tabs)/(notes)/7');
});

it('does not create a local note when Android microphone permission is denied', async () => {
  jest.mocked(PermissionsAndroid.request).mockResolvedValueOnce(PermissionsAndroid.RESULTS.DENIED);
  await startPrivateMeeting();
  expect(mockCreateNote).not.toHaveBeenCalled();
  expect(mockDurableStart).not.toHaveBeenCalled();
});

it.each(['blur', 'account', 'mode'] as const)(
  'stops local capture and suppresses stale work after %s',
  async (change) => {
    const view = await startPrivateMeeting();
    act(() => {
      if (change === 'blur') mockBlur?.();
      else {
        mockOwnerValid = false;
        if (change === 'account') mockAuthListener?.({ user: { id: 'b' } }, { user: mockUser });
        else mockModeListener?.({ activeMode: 'cloud' }, { activeMode: 'private' });
      }
    });
    await act(async () => undefined);
    expect(mockDurableStop).toHaveBeenCalledTimes(1);
    expect(mockNotes.runMeetingPipeline).not.toHaveBeenCalled();
    if (change !== 'blur') expect(mockNotes.transitionStatus).not.toHaveBeenCalled();
    view.unmount();
  },
);

it('handles native notification Stop once using the saved local recording', async () => {
  await startPrivateMeeting();
  await act(async () => {
    mockNativeStopped?.();
    mockNativeStopped?.();
  });
  expect(mockNotes.runMeetingPipeline).toHaveBeenCalledTimes(1);
  expect(mockReplace).toHaveBeenCalledWith('/(tabs)/(notes)/7');
});

it('retains an interrupted local note for retry without running the pipeline', async () => {
  await startPrivateMeeting();
  await act(async () => mockNativeStopped?.(new Error('Microphone interrupted')));
  expect(mockDurableStop).toHaveBeenCalled();
  expect(mockNotes.transitionStatus).toHaveBeenCalledWith(7, 'failed');
  expect(mockNotes.runMeetingPipeline).not.toHaveBeenCalled();
});

it('aborts local processing on leave and ignores its late completion', async () => {
  let finish!: () => void;
  mockNotes.runMeetingPipeline.mockImplementationOnce(
    () =>
      new Promise<void>((done) => {
        finish = done;
      }),
  );
  const view = await startPrivateMeeting();
  await act(async () => fireEvent.press(view.getByTestId('meeting-stop')));
  const signal = mockNotes.runMeetingPipeline.mock.calls[0]?.[3]?.signal;
  act(() => mockBlur?.());
  expect(signal?.aborted).toBe(true);
  await act(async () => finish());
  expect(mockReplace).not.toHaveBeenCalled();
});

it('cancels the speaker-model download and never starts from its late completion', async () => {
  mockMode = 'private';
  mockNotes.isDiarizerModelReady.mockResolvedValue(false);
  let downloaded!: () => void;
  mockNotes.downloadDiarizerModel.mockImplementationOnce(
    () =>
      new Promise<void>((done) => {
        downloaded = done;
      }),
  );
  const view = render(<MeetingRecordScreen />);
  await act(async () => fireEvent.press(view.getByTestId('begin')));
  await act(async () => fireEvent.press(view.getByTestId('model-download')));
  await act(async () => fireEvent.press(view.getByTestId('model-download-cancel')));
  expect(mockCancelDownload).toHaveBeenCalledWith('meeting-speakers');
  await act(async () => downloaded());
  await act(async () => mockFeature?.());
  expect(mockCreateNote).not.toHaveBeenCalled();
});

it('preserves a failed native start as a retryable note with its durable source', async () => {
  mockDurableStart.mockRejectedValueOnce(new Error('Microphone busy'));
  const view = await startPrivateMeeting();
  expect(mockDurableStop).toHaveBeenCalled();
  expect(mockNotes.transitionStatus).toHaveBeenCalledWith(7, 'failed');
  expect(view.getByTestId('begin')).toBeTruthy();
});

it('stops pending native startup on leave and never revives the recording screen', async () => {
  let started!: () => void;
  mockDurableStart.mockImplementationOnce(
    () =>
      new Promise<void>((done) => {
        started = done;
      }),
  );
  const view = await startPrivateMeeting();
  act(() => mockBlur?.());
  await act(async () => started());
  expect(mockDurableStop).toHaveBeenCalledTimes(1);
  expect(mockNotes.transitionStatus).toHaveBeenCalledWith(7, 'failed');
  expect(view.queryByTestId('meeting-stop')).toBeNull();
  expect(mockNotes.runMeetingPipeline).not.toHaveBeenCalled();
});

it('offers to stop and save before leaving a local recording', async () => {
  await startPrivateMeeting();
  const guard = jest.mocked(require('@react-navigation/native').usePreventRemove).mock.calls.at(-1);
  expect(guard?.[0]).toBe(true);
  act(() => (guard?.[1] as () => void)());
  const buttons = jest.mocked(Alert.alert).mock.calls.at(-1)?.[2];
  expect(buttons?.some((button) => button.text === 'meetingKeepRecording')).toBe(true);
  await act(async () => buttons?.find((button) => button.text === 'meetingStopSave')?.onPress?.());
  expect(mockNotes.runMeetingPipeline).toHaveBeenCalledTimes(1);
});

it('allows saving for later during local processing and retains a retryable note', async () => {
  let processed!: () => void;
  mockNotes.runMeetingPipeline.mockImplementationOnce(
    () =>
      new Promise<void>((done) => {
        processed = done;
      }),
  );
  const view = await startPrivateMeeting();
  await act(async () => fireEvent.press(view.getByTestId('meeting-stop')));
  const signal = mockNotes.runMeetingPipeline.mock.calls[0]?.[3]?.signal;
  const guard = jest.mocked(require('@react-navigation/native').usePreventRemove).mock.calls.at(-1);
  act(() => (guard?.[1] as () => void)());
  const buttons = jest.mocked(Alert.alert).mock.calls.at(-1)?.[2];
  await act(async () =>
    buttons?.find((button) => button.text === 'meetingSaveForLater')?.onPress?.(),
  );
  expect(signal?.aborted).toBe(true);
  expect(mockNotes.transitionStatus).toHaveBeenCalledWith(7, 'failed');
  expect(mockReplace).toHaveBeenCalledWith('/(tabs)/(notes)/7');
  await act(async () => processed());
  expect(mockReplace).toHaveBeenCalledTimes(1);
});

// Regression: canceling on account change must expose Retry when A returns,
// without letting the old capture/pipeline write while B is active.
it('makes the stopped local note retryable when its original account returns without restart', async () => {
  mockUseRealLocalContext = true;
  mockNotes.notes = [mockSavedNote];
  mockNotes.transitionStatus.mockImplementation((_id: number, status: string) => {
    mockSavedNote.transcriptionStatus = status;
  });
  const view = await startPrivateMeeting();
  await act(async () => {
    const previous = { user: mockUser };
    mockUser = { id: 'b' };
    mockAuthListener?.({ user: mockUser }, previous);
  });
  expect(mockDurableStop).toHaveBeenCalledTimes(1);
  expect(mockSavedNote.transcriptionStatus).toBe('recording');
  view.unmount();
  await act(async () => {
    const previous = { user: mockUser };
    mockUser = { id: 'a' };
    mockAuthListener?.({ user: mockUser }, previous);
  });
  expect(mockSavedNote.transcriptionStatus).toBe('failed');
  expect(mockNotes.runMeetingPipeline).not.toHaveBeenCalled();
});

it('waits for native Stop before recovering after a rapid account return', async () => {
  mockUseRealLocalContext = true;
  mockNotes.notes = [mockSavedNote];
  mockNotes.transitionStatus.mockImplementation((_id: number, status: string) => {
    mockSavedNote.transcriptionStatus = status;
  });
  let stopped!: (uri: string) => void;
  mockDurableStop.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        stopped = resolve;
      }),
  );
  const view = await startPrivateMeeting();
  await act(async () => {
    const previous = { user: mockUser };
    mockUser = { id: 'b' };
    mockAuthListener?.({ user: mockUser }, previous);
  });
  view.unmount();
  await act(async () => {
    const previous = { user: mockUser };
    mockUser = { id: 'a' };
    mockAuthListener?.({ user: mockUser }, previous);
  });
  expect(mockSavedNote.transcriptionStatus).toBe('recording');
  await act(async () => stopped('file:///app/documents/meeting-7.wav'));
  expect(mockSavedNote.transcriptionStatus).toBe('failed');
  expect(mockNotes.runMeetingPipeline).not.toHaveBeenCalled();
});

it('starts upstream iOS cloud recording directly without a local model or authorization gate', async () => {
  Platform.OS = 'ios';
  const view = render(<MeetingRecordScreen />);
  await act(async () => fireEvent.press(view.getByTestId('begin')));
  expect(mockRegisterGate).not.toHaveBeenCalled();
  expect(mockNotes.isDiarizerAvailable).not.toHaveBeenCalled();
  expect(mockCreateNote).toHaveBeenCalledWith({
    folderId: 2,
    spaceId: undefined,
    expectedSpeakerCount: undefined,
    calendarEventId: null,
    title: null,
    participants: null,
    diarizationEnabled: false,
  });
  expect(view.getByTestId('stop')).toBeTruthy();
});

it('finalizes upstream iOS cloud recording with the synchronous utterances and three arguments', async () => {
  Platform.OS = 'ios';
  const view = render(<MeetingRecordScreen />);
  await act(async () => fireEvent.press(view.getByTestId('begin')));
  await act(async () => fireEvent.press(view.getByTestId('stop')));
  expect(mockFinalize).toHaveBeenCalledWith(7, mockParts, 2);
  expect(mockReplace).toHaveBeenCalledWith('/(tabs)/(notes)/7');
});

it('marks an upstream iOS failed empty cloud recording failed without finalizing', async () => {
  Platform.OS = 'ios';
  mockIOSCloudStatus = 'error';
  mockStopIOSCloud.mockReturnValue([]);
  const view = render(<MeetingRecordScreen />);
  await act(async () => fireEvent.press(view.getByTestId('begin')));
  await act(async () => fireEvent.press(view.getByTestId('stop')));
  expect(mockFinalize).not.toHaveBeenCalled();
  expect(mockNotes.transitionStatus).toHaveBeenCalledWith(7, 'failed');
  expect(view.getByTestId('begin')).toBeTruthy();
});

it('returns upstream iOS to setup after cloud persistence fails', async () => {
  Platform.OS = 'ios';
  mockFinalize.mockRejectedValueOnce(new Error('database full'));
  const view = render(<MeetingRecordScreen />);
  await act(async () => fireEvent.press(view.getByTestId('begin')));
  await act(async () => fireEvent.press(view.getByTestId('stop')));
  expect(mockNotes.transitionStatus).toHaveBeenCalledWith(7, 'failed');
  expect(mockReplace).not.toHaveBeenCalled();
  expect(view.getByTestId('begin')).toBeTruthy();
  expect(view.queryByText('meetingSaveFailedBody')).toBeNull();
});

it('preserves the upstream iOS unavailable-device explanation', async () => {
  Platform.OS = 'ios';
  mockMode = 'private';
  mockNotes.isDiarizerAvailable.mockResolvedValueOnce(false);
  const view = render(<MeetingRecordScreen />);
  await act(async () => fireEvent.press(view.getByTestId('begin')));
  expect(
    view.getByText(
      'Meeting diarization runs on the Apple Neural Engine and needs iOS 17+ in a development or production build (not Expo Go or other platforms).',
    ),
  ).toBeTruthy();
  expect(mockCreateNote).not.toHaveBeenCalled();
});

it('shows the upstream iOS speech-model requirement before authorization', async () => {
  Platform.OS = 'ios';
  mockMode = 'private';
  mockNotes.isLocalAsrModelReady.mockResolvedValueOnce(false);
  const view = render(<MeetingRecordScreen />);
  await act(async () => fireEvent.press(view.getByTestId('begin')));
  expect(Alert.alert).toHaveBeenCalledWith(
    'Speech model needed',
    'Download a local speech model in Settings → AI Models → Dictation, then try again.',
  );
  expect(mockRegisterGate).not.toHaveBeenCalled();
  expect(mockCreateNote).not.toHaveBeenCalled();
});

it('preserves upstream iOS start immediately after diarizer download', async () => {
  Platform.OS = 'ios';
  mockMode = 'private';
  mockNotes.isDiarizerModelReady.mockResolvedValueOnce(false);
  const view = render(<MeetingRecordScreen />);
  await act(async () => fireEvent.press(view.getByTestId('begin')));
  await act(async () => fireEvent.press(view.getByTestId('model-download')));
  expect(mockNotes.downloadDiarizerModel).toHaveBeenCalledTimes(1);
  expect(mockRegisterGate).not.toHaveBeenCalled();
  expect(mockLocalStart).toHaveBeenCalledTimes(1);
  expect(view.getByTestId('meeting-stop')).toBeTruthy();
});

it('returns upstream iOS to setup after canceling the diarizer prompt', async () => {
  Platform.OS = 'ios';
  mockMode = 'private';
  mockNotes.isDiarizerModelReady.mockResolvedValueOnce(false);
  const view = render(<MeetingRecordScreen />);
  await act(async () => fireEvent.press(view.getByTestId('begin')));
  await act(async () => fireEvent.press(view.getByTestId('model-cancel')));
  expect(mockLocalStart).not.toHaveBeenCalled();
  expect(view.getByTestId('begin')).toBeTruthy();
});

it('does not create an upstream iOS note after a failed recorder start', async () => {
  Platform.OS = 'ios';
  mockMode = 'private';
  mockLocalStart.mockRejectedValueOnce(new Error('permission denied'));
  const view = render(<MeetingRecordScreen />);
  await act(async () => fireEvent.press(view.getByTestId('begin')));
  await act(async () => mockFeature?.());
  expect(mockCreateNote).not.toHaveBeenCalled();
  expect(view.getByTestId('begin')).toBeTruthy();
});

it('cancels the upstream iOS recording when note creation fails', async () => {
  Platform.OS = 'ios';
  mockMode = 'private';
  mockCreateNote.mockImplementationOnce(() => {
    throw new Error('database full');
  });
  const view = render(<MeetingRecordScreen />);
  await act(async () => fireEvent.press(view.getByTestId('begin')));
  await act(async () => mockFeature?.());
  expect(mockCancelLocal).toHaveBeenCalledTimes(1);
  expect(view.getByTestId('begin')).toBeTruthy();
});

it.each(['success', 'missing-file', 'copy-error', 'pipeline-error'] as const)(
  'preserves upstream iOS local completion: %s',
  async (outcome) => {
    Platform.OS = 'ios';
    mockMode = 'private';
    if (outcome === 'missing-file') mockStopLocalRaw.mockResolvedValueOnce(null);
    if (outcome === 'copy-error') mockCopy.mockRejectedValueOnce(new Error('copy failed'));
    if (outcome === 'pipeline-error')
      mockNotes.runMeetingPipeline.mockRejectedValueOnce(new Error('processing failed'));
    const view = render(<MeetingRecordScreen />);
    await act(async () => fireEvent.press(view.getByTestId('begin')));
    await act(async () => mockFeature?.());
    fireEvent.changeText(view.getByTestId('meeting-raw-notes'), 'A draft decision');
    await act(async () => fireEvent.press(view.getByTestId('meeting-stop')));
    expect(mockNotes.updateNote).toHaveBeenCalledWith(7, { content: 'A draft decision' });
    if (outcome === 'success') {
      expect(mockCopy).toHaveBeenCalledWith({
        from: 'file:///temporary.wav',
        to: 'file:///app/documents/meeting-7.wav',
      });
      expect(mockNotes.runMeetingPipeline).toHaveBeenCalledWith(
        7,
        'file:///app/documents/meeting-7.wav',
        undefined,
      );
      expect(mockReplace).toHaveBeenCalledWith('/(tabs)/(notes)/7');
    } else {
      expect(mockNotes.transitionStatus).toHaveBeenCalledWith(7, 'failed');
      expect(mockReplace).not.toHaveBeenCalled();
      expect(view.getByTestId('begin')).toBeTruthy();
    }
  },
);

it.each(['ios', 'android'] as const)(
  'retains the %s draft debounce and avoids saving it twice on Stop',
  async (platform) => {
    jest.useFakeTimers();
    Platform.OS = platform;
    mockMode = 'private';
    const view = render(<MeetingRecordScreen />);
    await act(async () => fireEvent.press(view.getByTestId('begin')));
    await act(async () => mockFeature?.());
    fireEvent.changeText(view.getByTestId('meeting-raw-notes'), 'A saved decision');
    act(() => jest.advanceTimersByTime(799));
    expect(mockNotes.updateNote).not.toHaveBeenCalled();
    act(() => jest.advanceTimersByTime(1));
    expect(mockNotes.updateNote).toHaveBeenCalledTimes(1);
    await act(async () => fireEvent.press(view.getByTestId('meeting-stop')));
    expect(mockNotes.updateNote).toHaveBeenCalledTimes(1);
    view.unmount();
    jest.useRealTimers();
  },
);

it('does not persist an Android recording draft after its owner changes', async () => {
  jest.useFakeTimers();
  const view = await startPrivateMeeting();
  fireEvent.changeText(view.getByTestId('meeting-raw-notes'), 'Account A only');
  mockOwnerValid = false;
  act(() => jest.advanceTimersByTime(800));
  expect(mockNotes.updateNote).not.toHaveBeenCalled();
  view.unmount();
  jest.useRealTimers();
});

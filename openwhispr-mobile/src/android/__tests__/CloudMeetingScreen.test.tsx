import React from 'react';
import { Platform, Alert, PermissionsAndroid } from 'react-native';
import { act, fireEvent, render } from '@testing-library/react-native';
import { CloudMeetingScreen as MeetingRecordScreen } from '../CloudMeetingScreen';
import { CloudMeetingFinishError } from '@/android/useCloudMeeting';

const mockCreateNote = jest.fn(() => ({ id: 7, content: '' }));
const mockFinalize = jest.fn(async () => undefined);
const mockReplace = jest.fn();
const mockLocalStart = jest.fn(async (): Promise<void> => undefined);
const mockCancelLocal = jest.fn(async () => undefined);
const mockStopCloud = jest.fn();
const mockCancelCloud = jest.fn(async (): Promise<void> => undefined);
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
let mockAudioNamespace = '';
jest.mock('@/android/accountData', () => ({
  useAccountData: {
    getState: () => ({
      owner: 'account:a',
      audioNamespace: mockAudioNamespace,
      revision: 1,
      error: null,
      blocked: false,
    }),
  },
}));
let mockFeature: (() => void) | undefined;
let mockBlur: (() => void) | undefined;
let mockFocus: (() => () => void) | undefined;
let mockAuthListener: ((state: unknown, previous: unknown) => void) | undefined;
let mockModeListener: ((state: unknown, previous: unknown) => void) | undefined;
let mockParams = { folderId: '2' };

const mockCancelDownload = jest.fn(async (_id: string) => undefined);
jest.mock('@/android/models', () => ({
  cancelAndroidDownload: (id: string) => mockCancelDownload(id),
}));
const mockDurableStart = jest.fn(async (): Promise<void> => undefined);
const mockDurableStop = jest.fn(async () => 'file:///app/documents/meeting-7.wav');
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
  LocalMeetingRecorder: jest.fn().mockImplementation(() => {
    return {
      uri: 'file:///app/documents/meeting-7.wav',
      start: mockDurableStart,
      stop: mockDurableStop,
    };
  }),
}));
jest.mock('@/android/localMeetingContext', () => ({
  createLocalMeetingContext: (_id: number, signal: AbortSignal = new AbortController().signal) =>
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
      mockFocus = callback;
      mockBlur = callback();
      return mockBlur;
    }, [callback]);
  },
}));
jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
jest.mock('@react-navigation/native', () => ({ usePreventRemove: jest.fn() }));
jest.mock('@react-navigation/elements', () => ({ useHeaderHeight: () => 0 }));
jest.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ bottom: 0 }) }));
jest.mock('expo-file-system/legacy', () => ({ documentDirectory: 'file:///app/documents/' }));
jest.mock('@/lib/meetingAudioStorage', () =>
  jest.requireActual('@/lib/meetingAudioStorage.android'),
);
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
  MeetingSetup: ({ onStart, busy }: { onStart: () => void; busy: boolean }) =>
    require('react').createElement(require('react-native').Pressable, {
      testID: 'begin',
      onPress: onStart,
      disabled: busy,
    }),
}));
jest.mock('@/components/notes/CloudMeetingRecording.android', () => ({
  CloudMeetingRecording: ({
    onStop,
    stopLabel,
    error,
    rawNotes,
    onChangeRawNotes,
  }: {
    onStop: () => void;
    stopLabel?: string;
    error?: string;
    rawNotes: string;
    onChangeRawNotes: (text: string) => void;
  }) =>
    require('react').createElement(
      require('react-native').Pressable,
      { testID: 'stop', onPress: onStop },
      require('react').createElement(
        require('react-native').Text,
        null,
        error ?? stopLabel ?? 'Stop',
      ),
      require('react').createElement(require('react-native').TextInput, {
        testID: 'raw-notes',
        value: rawNotes,
        onChangeText: onChangeRawNotes,
      }),
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
  useAudioRecording: () => ({ startRecording: mockLocalStart, cancelRecording: mockCancelLocal }),
}));
jest.mock('@/hooks/useKeyboardHeight', () => ({ useKeyboardHeight: () => 0 }));
jest.mock('@/hooks/useMeetingLiveActivity', () => ({ useMeetingLiveActivity: jest.fn() }));
jest.mock('@/hooks/useSuperwallGate', () => ({
  useSuperwallGate: () => ({
    register: async ({ feature }: { feature: () => void }) => {
      mockFeature = feature;
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
jest.mock('@/android/RealtimeMeetingWsService', () => ({
  startRealtimeMeetingWs: (...args: unknown[]) => mockRealtimeStart(...args),
}));
jest.mock('@/android/useCloudMeeting', () => ({
  ...jest.requireActual('@/android/useCloudMeeting'),
  useCloudMeeting: (options: unknown) =>
    mockUseRealCloudHook
      ? jest.requireActual('@/android/useCloudMeeting').useCloudMeeting(options)
      : {
          stop: mockStopCloud,
          cancel: mockCancelCloud,
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
  mockUseRealLocalContext = false;
  mockAuthListeners.clear();
  mockNotes.transitionStatus.mockReset();
  mockNotes.notes = [{ id: 7, transcriptionStatus: 'recording' }];
  mockSavedNote = { ...mockSavedNote, transcriptionStatus: 'recording', isPrivate: 1 };
  mockDurableStart.mockReset().mockResolvedValue(undefined);
  mockDurableStop.mockReset().mockResolvedValue('file:///app/documents/meeting-7.wav');
  mockNotes.runMeetingPipeline.mockReset().mockResolvedValue(undefined);
  mockNotes.isDiarizerModelReady.mockReset().mockResolvedValue(true);
  mockNotes.downloadDiarizerModel.mockReset().mockResolvedValue(undefined);
  mockUser = { id: 'a' };
  mockUseRealCloudHook = false;
  mockMode = 'cloud';
  mockAudioNamespace = '';
  mockParams = { folderId: '2' };
  mockFeature = undefined;
  mockFinalize.mockReset().mockResolvedValue(undefined);
  mockStopCloud.mockReset().mockResolvedValue(mockParts);
  mockCancelCloud.mockReset().mockResolvedValue(undefined);
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
  expect(Alert.alert).toHaveBeenCalledWith('errorTitle', 'meetingInterrupted');
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

it('keeps a Cloud meeting recording in its account audio directory for recovery', async () => {
  mockAudioNamespace = '11111111-2222-4333-8444-555555555555';
  const view = render(<MeetingRecordScreen />);
  await act(async () => fireEvent.press(view.getByTestId('begin')));
  await act(async () => mockFeature?.());
  expect(require('@/data').notesRepository.updateNoteMeta).toHaveBeenCalledWith(7, {
    sourceFile:
      'file:///app/documents/account-audio/11111111-2222-4333-8444-555555555555/meeting-7.wav',
  });
});

it('does not finalize a Cloud result after the account changes during Stop', async () => {
  let stopped!: (parts: typeof mockParts) => void;
  mockStopCloud.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        stopped = resolve;
      }),
  );
  const view = render(<MeetingRecordScreen />);
  await act(async () => fireEvent.press(view.getByTestId('begin')));
  await act(async () => mockFeature?.());
  await act(async () => fireEvent.press(view.getByTestId('stop')));
  await act(async () => {
    const previous = { user: mockUser };
    mockUser = { id: 'b' };
    mockAuthListener?.({ user: mockUser }, previous);
    stopped(mockParts);
  });
  expect(mockFinalize).not.toHaveBeenCalled();
  expect(mockReplace).not.toHaveBeenCalled();
});

it('restores Cloud Retry for the original account only after native Stop settles', async () => {
  mockUseRealCloudHook = true;
  mockUseRealLocalContext = true;
  mockSavedNote = { ...mockSavedNote, isPrivate: 0 };
  mockNotes.transitionStatus.mockImplementation((_id: number, status: string) => {
    mockSavedNote.transcriptionStatus = status;
  });
  let stopped!: () => void;
  const nativeStop = new Promise<void>((resolve) => {
    stopped = resolve;
  });
  mockRealtimeStart.mockResolvedValue({ stop: () => nativeStop, utterances: () => mockParts });
  const view = render(<MeetingRecordScreen />);
  await act(async () => fireEvent.press(view.getByTestId('begin')));
  await act(async () => mockFeature?.());
  await act(async () => {
    mockUser = { id: 'b' };
    mockAuthListener?.({ user: mockUser }, { user: { id: 'a' } });
  });
  view.unmount();
  await act(async () => {
    mockUser = { id: 'a' };
    mockAuthListener?.({ user: mockUser }, { user: { id: 'b' } });
  });
  expect(mockSavedNote.transcriptionStatus).toBe('recording');
  await act(async () => stopped());
  expect(mockSavedNote.transcriptionStatus).toBe('failed');
  expect(mockFinalize).not.toHaveBeenCalled();
});

it.each(['account', 'mode', 'blur'] as const)(
  'stops Android Cloud capture on %s without saving into a stale screen',
  async (change) => {
    mockUseRealCloudHook = true;
    const stop = jest.fn();
    mockRealtimeStart.mockResolvedValue({ stop, utterances: () => mockParts });
    const view = render(<MeetingRecordScreen />);
    await act(async () => fireEvent.press(view.getByTestId('begin')));
    await act(async () => mockFeature?.());
    const signal = mockRealtimeStart.mock.calls[0][0].signal;
    await act(async () => {
      if (change === 'blur') mockBlur?.();
      if (change === 'account') {
        const previous = { user: mockUser };
        mockUser = { id: 'b' };
        mockAuthListener?.({ user: mockUser }, previous);
      }
      if (change === 'mode') {
        mockMode = 'private';
        mockModeListener?.({ activeMode: mockMode }, { activeMode: 'cloud' });
      }
    });
    expect(signal.aborted).toBe(true);
    expect(stop).toHaveBeenCalled();
    expect(mockFinalize).not.toHaveBeenCalled();
    expect(mockReplace).not.toHaveBeenCalled();
  },
);

async function openCancelAlert() {
  const view = render(<MeetingRecordScreen />);
  await act(async () => fireEvent.press(view.getByTestId('begin')));
  await act(async () => mockFeature?.());
  const guard = jest
    .mocked(require('@react-navigation/native').usePreventRemove)
    .mock.calls.at(-1)![1] as () => void;
  act(() => guard());
  const buttons = jest.mocked(Alert.alert).mock.calls.at(-1)![2]!;
  return { view, cancel: buttons.find((button) => button.text === 'cancel')!.onPress! };
}
it('waits for native Stop before Cancel marks the note retryable or navigates', async () => {
  let stopped!: () => void;
  mockCancelCloud.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        stopped = resolve;
      }),
  );
  const { view, cancel } = await openCancelAlert();
  await act(async () => cancel());
  expect(mockNotes.transitionStatus).not.toHaveBeenCalled();
  expect(mockReplace).not.toHaveBeenCalled();
  expect(view.queryByTestId('begin')).toBeNull();
  await act(async () => stopped());
  expect(mockNotes.transitionStatus).toHaveBeenCalledWith(7, 'failed');
  expect(mockReplace).toHaveBeenCalledWith('/(tabs)/(notes)/7');
});
it('ignores a retained Cancel alert after the active account changes', async () => {
  mockUseRealLocalContext = true;
  const { cancel } = await openCancelAlert();
  await act(async () => {
    mockUser = { id: 'b' };
    mockAuthListener?.({ user: mockUser }, { user: { id: 'a' } });
  });
  await act(async () => cancel());
  expect(mockNotes.transitionStatus).not.toHaveBeenCalled();
  expect(mockReplace).not.toHaveBeenCalled();
});

it('returns to setup after blur and refocus only when native cancellation has settled', async () => {
  let stopped!: () => void;
  mockCancelCloud.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        stopped = resolve;
      }),
  );
  const view = render(<MeetingRecordScreen />);
  await act(async () => fireEvent.press(view.getByTestId('begin')));
  await act(async () => mockFeature?.());
  await act(async () => mockBlur?.());
  act(() => {
    mockFocus?.();
  });
  expect(view.queryByTestId('begin')).toBeNull();
  await act(async () => stopped());
  expect(view.getByTestId('begin')).toBeTruthy();
  expect(view.queryByTestId('stop')).toBeNull();
});
it('allows retry after the cancelled recording status could not be saved', async () => {
  mockNotes.transitionStatus.mockImplementationOnce(() => {
    throw new Error('database busy');
  });
  const { view, cancel } = await openCancelAlert();
  await act(async () => cancel());
  expect(mockReplace).not.toHaveBeenCalled();
  expect(view.getByText('meetingSaveFailedBody')).toBeTruthy();
  await act(async () => fireEvent.press(view.getByTestId('stop')));
  expect(mockNotes.transitionStatus).toHaveBeenCalledTimes(2);
  expect(mockReplace).toHaveBeenCalledWith('/(tabs)/(notes)/7');
});

it('stops native capture even when saving the latest draft fails during blur', async () => {
  mockUseRealCloudHook = true;
  const stop = jest.fn(async () => undefined);
  mockRealtimeStart.mockResolvedValue({ stop, utterances: () => mockParts });
  const view = render(<MeetingRecordScreen />);
  await act(async () => fireEvent.press(view.getByTestId('begin')));
  await act(async () => mockFeature?.());
  const signal = mockRealtimeStart.mock.calls[0][0].signal;
  mockNotes.updateNote.mockImplementationOnce(() => {
    throw new Error('database full');
  });
  act(() => fireEvent.changeText(view.getByTestId('raw-notes'), 'Keep this draft'));
  await act(async () => mockBlur?.());
  expect(signal.aborted).toBe(true);
  expect(stop).toHaveBeenCalled();
  expect(mockReplace).not.toHaveBeenCalled();
  expect(view.getByText('meetingSaveFailedBody')).toBeTruthy();
});

it('never restores a failed-cancellation draft to a different account', async () => {
  mockUseRealLocalContext = true;
  let stopped!: () => void;
  mockCancelCloud.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        stopped = resolve;
      }),
  );
  const { view, cancel } = await openCancelAlert();
  act(() => fireEvent.changeText(view.getByTestId('raw-notes'), 'Account A private draft'));
  mockNotes.updateNote.mockImplementationOnce(() => {
    throw new Error('database full');
  });
  await act(async () => cancel());
  await act(async () => {
    mockUser = { id: 'b' };
    mockAuthListener?.({ user: mockUser }, { user: { id: 'a' } });
    stopped();
  });
  expect(view.queryByTestId('raw-notes')).toBeNull();
  expect(view.getByTestId('begin')).toBeTruthy();
  expect(mockReplace).not.toHaveBeenCalled();
});
it('clears setup busy state when a pending permission request is abandoned offscreen', async () => {
  let grant!: (value: typeof PermissionsAndroid.RESULTS.GRANTED) => void;
  jest.mocked(PermissionsAndroid.request).mockReturnValueOnce(
    new Promise((resolve) => {
      grant = resolve;
    }),
  );
  const view = render(<MeetingRecordScreen />);
  await act(async () => fireEvent.press(view.getByTestId('begin')));
  expect(view.getByTestId('begin')).toBeDisabled();
  await act(async () => mockBlur?.());
  act(() => {
    mockFocus?.();
  });
  await act(async () => grant(PermissionsAndroid.RESULTS.GRANTED));
  expect(view.getByTestId('begin')).toBeEnabled();
  expect(mockCreateNote).not.toHaveBeenCalled();
});

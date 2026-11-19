jest.mock('@/store/useTranscriptStore.android', () =>
  jest.requireMock('@/store/useTranscriptStore'),
);
const mockUnassignedHistory = jest.fn(async () => []);
jest.mock('@/services/storage/StorageService.android', () => ({
  StorageService: { getUnassignedTranscripts: () => mockUnassignedHistory() },
}));
import React from 'react';
import * as transcriptionErrors from '@/lib/transcriptionErrors';
import { toFriendlyTranscriptionErrorMessage as androidMessage } from '@/lib/transcriptionErrors.android';
import { Alert } from 'react-native';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { useFocusEffect } from 'expo-router';

jest.mock('expo-router', () => ({ router: { push: jest.fn() }, useFocusEffect: jest.fn() }));
jest.mock('@react-navigation/native', () => ({
  useIsFocused: () => true,
  useScrollToTop: () => undefined,
}));
const mockStatus = {
  overlay: true,
  accessibility: true,
  microphone: true,
  enabled: true,
  batteryExempt: true,
};
const mockOpenSettings = jest.fn();
jest.mock('../../../modules/android-dictation/src', () => ({
  AndroidDictation: {
    getStatus: () => ({ ...mockStatus }),
    openSettings: (...args: unknown[]) => mockOpenSettings(...args),
  },
  dictationEvents: null,
}));
// The notch's motion needs the native animation and SVG modules; this stand-in shows what it
// would say, its ✕, and lets a test finish the slide back.
jest.mock('@/android/home/Notch', () => {
  const { Pressable, Text, View } = require('react-native');
  return {
    NOTCH_REACH: 44,
    Notch: ({ state, onFinished }: any) => (
      <View>
        <Text>{state.text}</Text>
        {state.detail ? <Text>{state.detail}</Text> : null}
        {state.onCancel ? (
          <Pressable accessibilityLabel="cancelUpload" onPress={state.onCancel}>
            <Text>cancelUpload</Text>
          </Pressable>
        ) : null}
        {state.kind === 'closing' ? <Text>notch-closing</Text> : null}
        {state.kind === 'done' || state.kind === 'closing' ? (
          <Pressable onPress={onFinished}>
            <Text>notch-finished</Text>
          </Pressable>
        ) : null}
      </View>
    ),
  };
});
jest.mock('@/android/home/OlderRecordings', () => {
  const { Pressable, Text, View } = require('react-native');
  return {
    OlderRecordingsRow: ({ count, onPress }: { count: number; onPress: () => void }) => (
      <Pressable onPress={onPress}>
        <Text>olderRecordings</Text>
        <Text>{`count:${count}`}</Text>
      </Pressable>
    ),
    OlderRecordingsSheet: ({
      visible,
      items,
      onClose,
    }: {
      visible: boolean;
      items: { id: string; text: string }[];
      onClose: () => void;
    }) =>
      visible ? (
        <View>
          {items.map((item) => (
            <Text key={item.id}>{item.text}</Text>
          ))}
          <Pressable onPress={onClose}>
            <Text>close-sheet</Text>
          </Pressable>
        </View>
      ) : null,
  };
});
jest.mock('@/android/home/TryItRecorder', () => {
  const { Pressable, Text } = require('react-native');
  return {
    TryItRecorder: ({ onDone }: { onDone: (recording: unknown) => void }) => (
      <Pressable
        onPress={() => onDone({ uri: 'file://cache/try.wav', durationMs: 2000, noSpeech: false })}
      >
        <Text>recorder-done</Text>
      </Pressable>
    ),
  };
});
jest.mock('@/android/home/strings', () => ({ useHomeT: () => (key: string) => key }));
// The tip videos need the native player; the row is covered on the phone.
jest.mock('@/android/home/Sections', () => ({
  ...jest.requireActual('@/android/home/Sections'),
  Tips: () => null,
}));
jest.mock('expo-video', () => ({ useVideoPlayer: jest.fn(), VideoView: () => null }));
jest.mock('@/components/ui/SystemIcon', () => ({ SystemIcon: () => null }));
jest.mock('expo-clipboard', () => ({ setStringAsync: jest.fn() }));
const mockRetryTranscript = jest.fn();
let mockUser: { id: string } | null = null;
let mockSync = false;
let mockInsights = {
  consentPaused: false,
  scope: 'device',
  ledger: {
    events: [
      { event_id: 'one', word_count: 42, local_date: '2020-01-01', spoken_duration_ms: null },
    ],
    acknowledged: [] as string[],
    summary: undefined as
      | { totalWords: number; totalDictations: number; averageWpm?: number | null }
      | undefined,
  },
  status: 'idle',
};
jest.mock('@/android/insights', () => ({
  refreshInsights: jest.fn(),
  useInsights: () => mockInsights,
}));
jest.mock('@/store/useConfigStore', () => ({
  useConfigStore: (select: any) =>
    select({ config: { insightsSyncEnabled: mockSync, androidHistoryDays: 30 } }),
}));
jest.mock('@/android/bubbleResult', () => ({ useBubbleResult: () => ({}) }));
jest.mock('@/android/Practice', () => ({ Practice: () => null }));
jest.mock('@/android/pipeline', () => ({
  applyHistoryRetention: jest.fn(async () => {}),
  AndroidCleanupError: class extends Error {},
  createAndroidJob: jest.fn(),
  ensureAndroidModels: jest.fn(),
  processAndroidAudio: jest.fn(),
}));
jest.mock('@/hooks/useAppInit', () => ({ useAppInit: jest.fn() }));
const mockPickFile = jest.fn();
const mockProcessUpload = jest.fn();
const mockSaveUpload = jest.fn();
const mockSaveFailedUpload = jest.fn();
const mockRegister = jest.fn();
let mockUploadProvider = 'byok';
jest.mock('expo-document-picker', () => ({
  getDocumentAsync: (...args: unknown[]) => mockPickFile(...args),
}));
jest.mock('expo-file-system/legacy', () => ({
  cacheDirectory: 'file://cache/',
  deleteAsync: jest.fn(async () => undefined),
  getInfoAsync: jest.fn(async () => ({ exists: true, size: 64044 })),
}));
jest.mock('../../../modules/audio-tools/src', () => ({
  AudioTools: { isAvailable: () => false, cleanup: jest.fn(async () => undefined) },
}));
jest.mock('@/services/transcription/TranscriptionService', () => ({
  isOggOpus: () => false,
  isLocalModelMissingError: () => false,
}));
jest.mock('@/lib/transcriptScope', () => ({
  captureTranscriptScope: () => null,
  isTranscriptScopeCurrent: () => true,
  observeTranscriptScope: () => () => {},
}));
jest.mock('@/lib/transcribeAndCleanup', () => ({
  transcribeAndCleanup: (...args: unknown[]) => mockProcessUpload(...args),
}));
jest.mock('@/lib/transcriptionLanguage', () => ({ getPreferredTranscriptionLanguage: () => 'en' }));
jest.mock('@/lib/permissions', () => ({ isNoSpeechError: () => false }));
jest.mock('@/lib/transcriptAudio', () => ({
  retainTranscriptAudio: jest.fn(async () => 'file://docs/upload.wav'),
  deleteManagedTranscriptAudio: jest.fn(async () => undefined),
}));
jest.mock('@/hooks/useSuperwallGate', () => ({
  useSuperwallGate: () => ({ register: mockRegister }),
}));
jest.mock('@/lib/inferenceRouting', () => ({
  getTranscriptionProvider: () => mockUploadProvider,
  snapshotTranscriptionJob: () => ({ provider: mockUploadProvider }),
  snapshotTextInference: () => ({}),
}));
jest.mock('@/lib/accountAccess', () => ({ accountRequiredForCloud: () => false }));
jest.mock('@/lib/superwall', () => ({
  SUPERWALL_PLACEMENTS: { audioUploadStart: 'audio-upload-start' },
}));
jest.mock('@/store/useAuthStore', () => ({ useAuthStore: () => mockUser }));
jest.mock('@/store/useUsageStore', () => ({ useUsageStore: () => null }));
jest.mock('@/store/useTranscriptStore', () => ({
  createTranscriptId: () => 'initial-upload',
  useTranscriptStore: Object.assign(
    (select: any) =>
      select({
        error: null,
        addTranscript: mockSaveUpload,
        addFailedTranscript: mockSaveFailedUpload,
        transcripts: [
          {
            id: 'done',
            text: 'Hello there.',
            status: 'completed',
            createdAt: 1,
            provider: 'local',
          },
          { id: 'legacy', text: 'One more dictation.', createdAt: 2, provider: 'local' },
          {
            id: 'failed',
            text: 'Unfinished raw audio',
            status: 'failed',
            createdAt: 3,
            provider: 'local',
            errorMessage: 'Unreadable audio',
            audioUrl: 'file:///invalid.wav',
          },
        ],
      }),
    { getState: () => ({ retryTranscript: mockRetryTranscript }) },
  ),
}));
jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);
jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  initReactI18next: { type: '3rdParty', init: () => undefined },
}));
jest.mock('@/components/ui/Text', () => ({ Text: require('react-native').Text }));
jest.mock('@/android/ui', () => {
  const { View, Text, Pressable } = require('react-native');
  return {
    Page: View,
    Card: View,
    Row: ({ title, onPress }: any) => (
      <Pressable onPress={onPress}>
        <Text>{title}</Text>
      </Pressable>
    ),
    styles: {},
    Button: ({ label, ...props }: { label: string }) => (
      <Pressable {...props}>
        <Text>{label}</Text>
      </Pressable>
    ),
  };
});

import AndroidHome from '../HomeScreen.android';

it('uses durable dictation statistics rather than retained transcripts and keeps failed audio retryable', () => {
  render(<AndroidHome />);
  expect(screen.getByText('42')).toBeTruthy();
  expect(screen.getByText('Unreadable audio')).toBeTruthy();
  expect(screen.getByLabelText('retry')).toBeTruthy();
  // History rows carry no provider or source tag.
  expect(screen.queryByText(/local|cloud|byok/)).toBeNull();
});

beforeEach(() => {
  jest.clearAllMocks();
  // Jest uses the default entry; Metro selects the Android formatter for this screen.
  jest
    .spyOn(transcriptionErrors, 'toFriendlyTranscriptionErrorMessage')
    .mockImplementation(androidMessage);
  mockUploadProvider = 'byok';
  mockPickFile.mockReset();
  mockProcessUpload.mockReset().mockImplementation(async () => ({
    text: 'Fresh upload',
    originalText: 'Fresh upload',
    transcription: { provider: mockUploadProvider, duration: 2 },
  }));
  mockRegister.mockReset().mockImplementation(async ({ feature }) => feature());
  mockPickFile.mockResolvedValue({
    canceled: false,
    assets: [{ uri: 'file://cache/input.wav', name: 'input.wav', size: 64044 }],
  });
  mockUser = null;
  mockSync = false;
  mockInsights = {
    consentPaused: false,
    scope: 'device',
    ledger: {
      events: [
        { event_id: 'one', word_count: 42, local_date: '2020-01-01', spoken_duration_ms: null },
      ],
      acknowledged: [],
      summary: undefined,
    },
    status: 'idle',
  };
});

it('aborts an initial upload when Home loses focus, without saving a late result', async () => {
  let signal: AbortSignal | undefined;
  let finish!: (value: unknown) => void;
  mockProcessUpload.mockImplementationOnce((_route, options) => {
    signal = options.signal;
    return new Promise((resolve) => {
      finish = resolve;
    });
  });
  render(<AndroidHome />);
  const onFocus = jest.mocked(useFocusEffect).mock.calls.at(-1)![0];
  let onBlur: ReturnType<typeof onFocus>;
  act(() => {
    onBlur = onFocus();
  });
  await act(async () => fireEvent.press(screen.getByText('uploadAudio')));
  expect(screen.getByText('uploadingPercent')).toBeTruthy();
  // The buttons keep their words while busy.
  expect(screen.getByText('uploadAudio')).toBeTruthy();
  expect(screen.getByText('dictate')).toBeTruthy();
  expect(screen.getByText('input.wav')).toBeTruthy();
  expect(signal?.aborted).toBe(false);
  act(() => {
    if (typeof onBlur === 'function') onBlur();
  });
  const abortedOnBlur = signal?.aborted;
  await act(async () => {
    finish({
      text: 'Late result',
      originalText: 'Late result',
      transcription: { provider: 'byok' },
    });
  });
  expect(abortedOnBlur).toBe(true);
  expect(screen.queryByText('uploadingPercent')).toBeNull();
  expect(screen.queryByText('writingItUpMinute')).toBeNull();
  expect(mockSaveUpload).not.toHaveBeenCalled();
  expect(mockSaveFailedUpload).not.toHaveBeenCalled();
});

it('does not start processing a picker result after Home loses focus', async () => {
  let finishPicker!: (value: unknown) => void;
  mockPickFile.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finishPicker = resolve;
      }),
  );
  mockProcessUpload.mockResolvedValueOnce({
    text: 'Unexpected result',
    transcription: { provider: 'byok' },
  });
  render(<AndroidHome />);
  const onFocus = jest.mocked(useFocusEffect).mock.calls.at(-1)![0];
  let onBlur: ReturnType<typeof onFocus>;
  act(() => {
    onBlur = onFocus();
  });
  await act(async () => fireEvent.press(screen.getByText('uploadAudio')));
  act(() => {
    if (typeof onBlur === 'function') onBlur();
  });
  await act(async () => {
    finishPicker({
      canceled: false,
      assets: [{ uri: 'file://cache/input.wav', name: 'input.wav', size: 64044 }],
    });
  });
  expect(mockProcessUpload).not.toHaveBeenCalled();
  expect(mockSaveUpload).not.toHaveBeenCalled();
  expect(mockSaveFailedUpload).not.toHaveBeenCalled();
  expect(screen.queryByText('uploadingPercent')).toBeNull();
  expect(screen.queryByText('writingItUpMinute')).toBeNull();
});

it('ignores a deferred Cloud upload grant from an earlier Home visit', async () => {
  mockUser = { id: 'a' };
  mockUploadProvider = 'cloud';
  let grant!: () => void;
  mockRegister.mockImplementationOnce(
    ({ feature }) =>
      new Promise<void>((resolve) => {
        grant = () => {
          feature();
          resolve();
        };
      }),
  );
  render(<AndroidHome />);
  const onFocus = jest.mocked(useFocusEffect).mock.calls.at(-1)![0];
  let onBlur: ReturnType<typeof onFocus>;
  act(() => {
    onBlur = onFocus();
  });
  await act(async () => fireEvent.press(screen.getByText('uploadAudio')));
  act(() => {
    if (typeof onBlur === 'function') onBlur();
    onFocus();
  });
  await act(async () => grant());
  expect(mockPickFile).not.toHaveBeenCalled();
  expect(mockProcessUpload).not.toHaveBeenCalled();
  expect(mockSaveUpload).not.toHaveBeenCalled();
});

it('allows a new Cloud upload after returning to Home', async () => {
  mockUser = { id: 'a' };
  mockUploadProvider = 'cloud';
  render(<AndroidHome />);
  const onFocus = jest.mocked(useFocusEffect).mock.calls.at(-1)![0];
  act(() => {
    const onBlur = onFocus();
    if (typeof onBlur === 'function') onBlur();
    onFocus();
  });
  await act(async () => fireEvent.press(screen.getByText('uploadAudio')));
  expect(mockSaveUpload).toHaveBeenCalledWith(
    expect.objectContaining({ text: 'Fresh upload', provider: 'cloud' }),
  );
  // The finished bar stays full for a moment before the card goes.
  await act(async () => new Promise((resolve) => setTimeout(resolve, 600)));
  expect(screen.queryByText('uploadingPercent')).toBeNull();
  expect(screen.queryByText('writingItUpMinute')).toBeNull();
});
it('shows unavailable account counts while loading rather than local counts presented as account totals', () => {
  mockUser = { id: 'a' };
  mockSync = true;
  mockInsights.scope = 'account:a';
  mockInsights.status = 'loading';
  render(<AndroidHome />);
  expect(screen.getAllByText('—')).toHaveLength(3);
  expect(screen.queryByText('42')).toBeNull();
  expect(screen.getByText('statsLoading')).toBeTruthy();
});
it('keeps cached account totals visible offline without adding pending local words', () => {
  mockUser = { id: 'a' };
  mockSync = true;
  mockInsights.scope = 'account:a';
  mockInsights.status = 'offline';
  mockInsights.ledger.summary = { totalWords: 100, totalDictations: 5 };
  render(<AndroidHome />);
  expect(screen.getByText('100')).toBeTruthy();
  expect(screen.getByText('statsOffline')).toBeTruthy();
  expect(screen.queryByText('142')).toBeNull();
});
it('distinguishes a confirmed zero from unavailable account totals and labels pending dictations', () => {
  mockUser = { id: 'a' };
  mockSync = true;
  mockInsights.scope = 'account:a';
  mockInsights.ledger.summary = { totalWords: 0, totalDictations: 0 };
  render(<AndroidHome />);
  expect(screen.getAllByText('0')).toHaveLength(1);
  expect(screen.getByText('statsPending')).toBeTruthy();
});
it('hides the previous account totals immediately when the account changes', () => {
  mockUser = { id: 'b' };
  mockSync = true;
  mockInsights.scope = 'account:a';
  mockInsights.ledger.summary = { totalWords: 100, totalDictations: 5 };
  render(<AndroidHome />);
  expect(screen.queryByText('100')).toBeNull();
  expect(screen.getAllByText('—')).toHaveLength(3);
  expect(screen.getByText('statsLoading')).toBeTruthy();
});
it('labels unavailable offline totals without inventing zero', () => {
  mockUser = { id: 'a' };
  mockSync = true;
  mockInsights.scope = 'account:a';
  mockInsights.status = 'offline';
  render(<AndroidHome />);
  expect(screen.getAllByText('—')).toHaveLength(3);
  expect(screen.getByText('statsUnavailable')).toBeTruthy();
});

it('shows device counts with a paused label after an opt-out fails to persist', () => {
  mockUser = { id: 'a' };
  mockSync = true;
  mockInsights.scope = 'account:a';
  mockInsights.consentPaused = true;
  render(<AndroidHome />);
  expect(screen.getByText('42')).toBeTruthy();
  expect(screen.getByText('statsPaused')).toBeTruthy();
  expect(screen.queryByText('statsLoading')).toBeNull();
});

describe('history retry controls', () => {
  let signal: AbortSignal | undefined;
  beforeEach(() => {
    signal = undefined;
    mockRetryTranscript.mockImplementation((_id, cancellation) => {
      signal = cancellation;
      return new Promise((_, reject) => {
        signal?.addEventListener('abort', () =>
          reject(Object.assign(new Error('cancelled'), { name: 'AbortError' })),
        );
      });
    });
  });

  it('shows Cancel during a history retry and aborts that request', async () => {
    render(<AndroidHome />);
    await act(async () => fireEvent.press(screen.getByLabelText('retry')));
    expect(screen.getByText('writingItUpMinute')).toBeTruthy();
    await act(async () => fireEvent.press(screen.getByLabelText('cancelUpload')));
    expect(signal?.aborted).toBe(true);
    expect(screen.queryByText('uploadingPercent')).toBeNull();
    expect(screen.queryByText('writingItUpMinute')).toBeNull();
    expect(screen.getByText('Unreadable audio')).toBeTruthy();
    // The notch slides back rather than vanishing, then goes once it is in.
    expect(screen.getByText('notch-closing')).toBeTruthy();
    fireEvent.press(screen.getByText('notch-finished'));
    expect(screen.queryByText('notch-closing')).toBeNull();
  });

  it('aborts a pending retry when the screen unmounts', async () => {
    const view = render(<AndroidHome />);
    await act(async () => fireEvent.press(screen.getByLabelText('retry')));
    await act(async () => view.unmount());
    expect(signal?.aborted).toBe(true);
  });

  it('aborts a pending retry when the account changes', async () => {
    mockUser = { id: 'a' };
    const view = render(<AndroidHome />);
    await act(async () => fireEvent.press(screen.getByLabelText('retry')));
    mockUser = { id: 'b' };
    await act(async () => view.rerender(<AndroidHome />));
    expect(signal?.aborted).toBe(true);
  });
});

it('offers older recordings in a sheet when signed out and there are some', async () => {
  mockUnassignedHistory.mockResolvedValue([
    { id: 'old', text: 'Unassigned text', createdAt: 1 },
  ] as never);
  const view = render(<AndroidHome />);
  await act(async () => {
    jest.mocked(useFocusEffect).mock.calls.forEach(([focus]) => focus());
  });
  expect(screen.getByText('count:1')).toBeTruthy();
  expect(screen.queryByText('Unassigned text')).toBeNull();
  await act(async () => fireEvent.press(screen.getByText('olderRecordings')));
  expect(screen.getByText('Unassigned text')).toBeTruthy();
  fireEvent.press(screen.getByText('close-sheet'));
  expect(screen.queryByText('Unassigned text')).toBeNull();
  mockUser = { id: 'b' };
  view.rerender(<AndroidHome />);
  expect(screen.queryByText('olderRecordings')).toBeNull();
  mockUnassignedHistory.mockReset().mockImplementation(async () => []);
});

it('hides the older recordings row when the archive is empty', async () => {
  render(<AndroidHome />);
  await act(async () => {
    jest.mocked(useFocusEffect).mock.calls.forEach(([focus]) => focus());
  });
  expect(screen.queryByText('olderRecordings')).toBeNull();
});

it('shows connection recovery guidance when a saved upload retry cannot resolve the server', async () => {
  const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  mockRetryTranscript.mockRejectedValueOnce(
    new Error('Unable to resolve host "preview.example.test": No address associated with hostname'),
  );
  render(<AndroidHome />);
  await act(async () => fireEvent.press(screen.getByLabelText('retry')));
  expect(alert).toHaveBeenCalledWith(
    'errorTitle',
    'No internet connection. Check your connection and try again.',
  );
  expect(screen.queryByText('uploadingPercent')).toBeNull();
  expect(screen.queryByText('writingItUpMinute')).toBeNull();
  expect(screen.getByLabelText('retry')).toBeTruthy();
  alert.mockRestore();
});

describe('bubble card', () => {
  afterEach(() => Object.assign(mockStatus, { overlay: true, accessibility: true }));

  it('turns orange with one button for the missing permission and keeps Upload audio', () => {
    mockStatus.accessibility = false;
    render(<AndroidHome />);
    expect(screen.getByText('bubbleOff')).toBeTruthy();
    expect(screen.getByText('needsOnePermission')).toBeTruthy();
    expect(screen.queryByText('dictate')).toBeNull();
    expect(screen.getByText('uploadAudio')).toBeTruthy();
    fireEvent.press(screen.getByText('turnOnAccessibility'));
    expect(mockOpenSettings).toHaveBeenCalledWith('accessibility');
  });

  it('asks for display over other apps first when two permissions are missing', () => {
    mockStatus.overlay = false;
    mockStatus.accessibility = false;
    render(<AndroidHome />);
    expect(screen.getByText('needsPermissions')).toBeTruthy();
    expect(screen.getByText('turnOnOverlay')).toBeTruthy();
  });

  it('shows the bubble is on with Try it and Upload audio side by side', () => {
    render(<AndroidHome />);
    expect(screen.getByText('bubbleOn')).toBeTruthy();
    expect(screen.getByText('dictate')).toBeTruthy();
    expect(screen.getByText('uploadAudio')).toBeTruthy();
  });
});

it('copies a Try it dictation to the clipboard and says so at the bottom', async () => {
  const pipeline = jest.requireMock('@/android/pipeline');
  const clipboard = jest.requireMock('expo-clipboard');
  clipboard.setStringAsync.mockResolvedValue(undefined);
  pipeline.createAndroidJob.mockReturnValue({ route: { provider: 'local' } });
  pipeline.ensureAndroidModels.mockResolvedValue(undefined);
  let finish!: (text: string) => void;
  pipeline.processAndroidAudio.mockImplementation(
    () => new Promise<string>((resolve) => (finish = resolve)),
  );
  render(<AndroidHome />);
  await act(async () => fireEvent.press(screen.getByText('dictate')));
  await act(async () => fireEvent.press(screen.getByText('recorder-done')));
  expect(screen.queryByText('recorder-done')).toBeNull();
  expect(screen.getByText('writingItUp')).toBeTruthy();
  await act(async () => finish('Testing this out.'));
  expect(clipboard.setStringAsync).toHaveBeenCalledWith('Testing this out.');
  expect(screen.getByText('copied', { includeHiddenElements: true })).toBeTruthy();
  // The notch shows the done state until it has slid back into the card.
  expect(screen.getByText('copiedAddedToHistory')).toBeTruthy();
  fireEvent.press(screen.getByText('notch-finished'));
  expect(screen.queryByText('copiedAddedToHistory')).toBeNull();
  expect(screen.getByText('dictate')).toBeTruthy();
});

it('says Added to History once an upload is written up', async () => {
  render(<AndroidHome />);
  await act(async () => fireEvent.press(screen.getByText('uploadAudio')));
  expect(mockSaveUpload).toHaveBeenCalled();
  expect(screen.getByText('addedToHistory', { includeHiddenElements: true })).toBeTruthy();
});

describe('bubble card buttons by screen width', () => {
  // The container holding both buttons: the nearest ancestor of one that also holds the other.
  const pairDirection = () => {
    const { StyleSheet } = require('react-native');
    const upload = screen.getByLabelText('uploadAudio');
    let node = screen.getByLabelText('dictate').parent;
    const contains = (root: any, target: any): boolean =>
      root === target || (root.children ?? []).some((child: any) => contains(child, target));
    while (node && !contains(node, upload)) node = node.parent;
    while (node && !StyleSheet.flatten(node.props.style)?.flexDirection) node = node.parent;
    return StyleSheet.flatten(node?.props.style)?.flexDirection;
  };
  const withWidth = (width: number) =>
    jest
      .spyOn(require('react-native'), 'useWindowDimensions')
      .mockReturnValue({ width, height: 800, scale: 2.8, fontScale: 1 });

  it('stacks them on a 360 dp phone', () => {
    withWidth(360);
    render(<AndroidHome />);
    expect(pairDirection()).toBe('column');
  });

  it('puts them side by side on the Galaxy A73 at its default display size (384 dp)', () => {
    withWidth(384);
    render(<AndroidHome />);
    expect(pairDirection()).toBe('row');
  });
});

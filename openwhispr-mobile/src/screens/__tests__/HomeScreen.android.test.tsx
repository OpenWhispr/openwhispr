const mockUnassignedHistory = jest.fn(async () => []);
jest.mock('@/services/storage/StorageService', () => ({
  StorageService: { getUnassignedTranscripts: () => mockUnassignedHistory() },
}));
import React from 'react';
import { Alert } from 'react-native';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { useFocusEffect } from 'expo-router';

jest.mock('expo-router', () => ({ router: { push: jest.fn() }, useFocusEffect: jest.fn() }));
jest.mock('expo-clipboard', () => ({ setStringAsync: jest.fn() }));
const mockRetryTranscript = jest.fn();
let mockUser: { id: string } | null = null;
let mockSync = false;
let mockInsights = {
  consentPaused: false,
  scope: 'device',
  ledger: {
    events: [{ event_id: 'one', word_count: 42 }],
    acknowledged: [] as string[],
    summary: undefined as { totalWords: number; totalDictations: number } | undefined,
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
jest.mock('@/android/pipeline', () => ({ applyHistoryRetention: jest.fn(async () => {}) }));
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
jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
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
  expect(screen.getByText('1')).toBeTruthy();
  expect(screen.getByText('42')).toBeTruthy();
  expect(screen.getByText('Unreadable audio')).toBeTruthy();
  expect(screen.getByText('retry')).toBeTruthy();
});

beforeEach(() => {
  jest.clearAllMocks();
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
    ledger: { events: [{ event_id: 'one', word_count: 42 }], acknowledged: [], summary: undefined },
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
  await act(async () => fireEvent.press(screen.getByText('upload')));
  expect(screen.getByText('processing')).toBeTruthy();
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
  expect(screen.queryByText('processing')).toBeNull();
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
  await act(async () => fireEvent.press(screen.getByText('upload')));
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
  expect(screen.queryByText('processing')).toBeNull();
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
  await act(async () => fireEvent.press(screen.getByText('upload')));
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
  await act(async () => fireEvent.press(screen.getByText('upload')));
  expect(mockSaveUpload).toHaveBeenCalledWith(
    expect.objectContaining({ text: 'Fresh upload', provider: 'cloud' }),
  );
  expect(screen.queryByText('processing')).toBeNull();
});
it('shows unavailable account counts while loading rather than local counts presented as account totals', () => {
  mockUser = { id: 'a' };
  mockSync = true;
  mockInsights.scope = 'account:a';
  mockInsights.status = 'loading';
  render(<AndroidHome />);
  expect(screen.getAllByText('—')).toHaveLength(2);
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
  expect(screen.getByText('5')).toBeTruthy();
  expect(screen.getByText('statsOffline')).toBeTruthy();
  expect(screen.queryByText('142')).toBeNull();
});
it('distinguishes a confirmed zero from unavailable account totals and labels pending dictations', () => {
  mockUser = { id: 'a' };
  mockSync = true;
  mockInsights.scope = 'account:a';
  mockInsights.ledger.summary = { totalWords: 0, totalDictations: 0 };
  render(<AndroidHome />);
  expect(screen.getAllByText('0')).toHaveLength(2);
  expect(screen.getByText('statsPending')).toBeTruthy();
});
it('hides the previous account totals immediately when the account changes', () => {
  mockUser = { id: 'b' };
  mockSync = true;
  mockInsights.scope = 'account:a';
  mockInsights.ledger.summary = { totalWords: 100, totalDictations: 5 };
  render(<AndroidHome />);
  expect(screen.queryByText('100')).toBeNull();
  expect(screen.getAllByText('—')).toHaveLength(2);
  expect(screen.getByText('statsLoading')).toBeTruthy();
});
it('labels unavailable offline totals without inventing zero', () => {
  mockUser = { id: 'a' };
  mockSync = true;
  mockInsights.scope = 'account:a';
  mockInsights.status = 'offline';
  render(<AndroidHome />);
  expect(screen.getAllByText('—')).toHaveLength(2);
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
    await act(async () => fireEvent.press(screen.getByText('retry')));
    expect(screen.getByText('processing')).toBeTruthy();
    await act(async () => fireEvent.press(screen.getByText('cancel')));
    expect(signal?.aborted).toBe(true);
    expect(screen.queryByText('processing')).toBeNull();
    expect(screen.getByText('Unreadable audio')).toBeTruthy();
  });

  it('aborts a pending retry when the screen unmounts', async () => {
    const view = render(<AndroidHome />);
    await act(async () => fireEvent.press(screen.getByText('retry')));
    await act(async () => view.unmount());
    expect(signal?.aborted).toBe(true);
  });

  it('aborts a pending retry when the account changes', async () => {
    mockUser = { id: 'a' };
    const view = render(<AndroidHome />);
    await act(async () => fireEvent.press(screen.getByText('retry')));
    mockUser = { id: 'b' };
    await act(async () => view.rerender(<AndroidHome />));
    expect(signal?.aborted).toBe(true);
  });
});

it('shows older history only after explicitly opening the signed-out archive', async () => {
  mockUnassignedHistory.mockResolvedValueOnce([
    { id: 'old', text: 'Unassigned text', createdAt: 1 },
  ] as never);
  const view = render(<AndroidHome />);
  expect(screen.queryByText('Unassigned text')).toBeNull();
  await act(async () => fireEvent.press(screen.getByText('olderDeviceHistory')));
  expect(screen.getByText('Unassigned text')).toBeTruthy();
  mockUser = { id: 'b' };
  view.rerender(<AndroidHome />);
  expect(screen.queryByText('Unassigned text')).toBeNull();
  expect(screen.queryByText('olderDeviceHistory')).toBeNull();
});

it('shows connection recovery guidance when a saved upload retry cannot resolve the server', async () => {
  const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  mockRetryTranscript.mockRejectedValueOnce(
    new Error('Unable to resolve host "preview.example.test": No address associated with hostname'),
  );
  render(<AndroidHome />);
  await act(async () => fireEvent.press(screen.getByText('retry')));
  expect(alert).toHaveBeenCalledWith(
    'errorTitle',
    'No internet connection. Check your connection and try again.',
  );
  expect(screen.queryByText('processing')).toBeNull();
  expect(screen.getByText('retry')).toBeTruthy();
  alert.mockRestore();
});

import { Linking } from 'react-native';
import { act, renderHook, waitFor } from '@testing-library/react-native';

type RecordingStoppedEvent = {
  fileUri: string;
  fileName: string;
  mimeType: string;
  recordingFormat: string;
  jobId: string;
  fileSizeBytes: number;
  recordingDurationMs: number;
};

const mockHandoffStoreState = {
  isActive: false,
  setActive: jest.fn(),
  setCheckingInitialUrl: jest.fn(),
  setNoSpeechDetected: jest.fn(),
  setTranscribing: jest.fn(),
  reset: jest.fn(),
};
const mockSubscription = { remove: jest.fn() };
const mockMarkRecoveryDeepLink = jest.fn();
const mockAddTranscript = jest.fn();
const mockCleanupTranscript = jest.fn();
const mockTranscribeAndCleanup = jest.fn();
const mockRetainTranscriptAudio = jest.fn();
const mockAnalyzeSpeechActivity = jest.fn();
let mockRecordingStoppedListener: ((event: RecordingStoppedEvent) => Promise<void>) | undefined;

jest.mock('../../../modules/app-group-storage/src', () => ({
  AppGroupStorage: {
    getItem: jest.fn(() => null),
    setItem: jest.fn(),
    removeItem: jest.fn(),
    setKeyboardStatus: jest.fn(),
    markKeyboardTiming: jest.fn(),
    endProcessingTask: jest.fn(),
    startNativeRecording: jest.fn(() => true),
    returnToPreviousApp: jest.fn(),
  },
  APP_GROUP_KEYS: {
    KEYBOARD_RECORDING_JOB_ID: 'keyboard_recording_job_id',
    KEYBOARD_RECORDING_FORMAT: 'keyboard_recording_format',
    KEYBOARD_HANDOFF_INTENT_AT_MS: 'keyboard_handoff_intent_at_ms',
    KEYBOARD_PENDING_TRANSCRIPT: 'keyboard_pending_transcript',
    KEYBOARD_PENDING_TRANSCRIPT_JOB_ID: 'keyboard_pending_transcript_job_id',
    KEYBOARD_ORPHANED_RAW_TRANSCRIPT: 'keyboard_orphaned_raw_transcript',
    KEYBOARD_ORPHANED_RAW_TRANSCRIPT_JOB_ID: 'keyboard_orphaned_raw_transcript_job_id',
    KEYBOARD_TRANSCRIPTION_ERROR: 'keyboard_transcription_error',
    KEYBOARD_CANCEL_REQUESTED: 'keyboard_cancel_requested',
    KEYBOARD_COMPRESSED_AUDIO_UNSUPPORTED: 'keyboard_compressed_audio_unsupported',
    KEYBOARD_COMPRESSED_AUDIO_UNSUPPORTED_AT_MS: 'keyboard_compressed_audio_unsupported_at_ms',
  },
  addRecordingStoppedListener: (listener: (event: RecordingStoppedEvent) => Promise<void>) => {
    mockRecordingStoppedListener = listener;
    return mockSubscription;
  },
  addRecordingErrorListener: () => mockSubscription,
  addBackgroundRecordingStartedListener: () => mockSubscription,
  addKeyboardStatusChangedListener: () => mockSubscription,
  addAgentActionListener: () => mockSubscription,
}));
jest.mock('../../../modules/live-activity/src', () => ({
  LiveActivity: { setDictationMode: jest.fn(), startSession: jest.fn() },
}));
jest.mock('@/store/useHandoffStore', () => ({
  useHandoffStore: { getState: () => mockHandoffStoreState },
}));
jest.mock('@/store/useKeyboardRecoveryStore', () => ({
  useKeyboardRecoveryStore: {
    getState: () => ({ markRecoveryDeepLink: mockMarkRecoveryDeepLink }),
  },
}));
jest.mock('@/store/useProcessingModeStore', () => ({
  useProcessingModeStore: { getState: () => ({ activeMode: 'cloud' }) },
}));
jest.mock('@/store/useTranscriptStore', () => ({
  useTranscriptStore: {
    getState: () => ({ addTranscript: mockAddTranscript, load: jest.fn() }),
  },
}));
jest.mock('@/store/useSnippetsStore', () => ({
  useSnippetsStore: { getState: () => ({ snippets: [] }) },
}));
jest.mock('@/services/transcription/TranscriptionService', () => ({
  TranscriptionService: { prepareLocal: jest.fn(() => Promise.resolve()) },
  isLocalModelMissingError: () => false,
}));
jest.mock('@/services/agent/AgentComposerService', () => ({
  generateForJob: jest.fn(),
  handleAgentAction: jest.fn(),
}));
jest.mock('@/lib/cleanupTranscript', () => ({
  cleanupTranscript: (...args: unknown[]) => mockCleanupTranscript(...args),
}));
jest.mock('@/lib/transcribeAndCleanup', () => ({
  transcribeAndCleanup: (...args: unknown[]) => mockTranscribeAndCleanup(...args),
}));
jest.mock('@/lib/keyboardToneSync', () => ({
  snapshotKeyboardTone: jest.fn(),
  readKeyboardToneSnapshot: jest.fn(() => null),
}));
jest.mock('@/lib/keyboardAgentSync', () => ({
  snapshotKeyboardAgentRequest: jest.fn(() => null),
  readKeyboardAgentJob: jest.fn(() => null),
  clearKeyboardAgentJob: jest.fn(),
  consumeKeyboardAgentAction: jest.fn(() => null),
}));
jest.mock('@/lib/snippets', () => ({ expandSnippets: (text: string) => text }));
jest.mock('@/lib/speechActivity', () => ({
  analyzeSpeechActivity: (...args: unknown[]) => mockAnalyzeSpeechActivity(...args),
  serializeSpeechActivityMetrics: jest.fn(),
}));
jest.mock('@/lib/transcriptionLanguage', () => ({
  getPreferredTranscriptionLanguage: () => 'en',
}));
jest.mock('@/lib/transcriptionErrors', () => ({
  toFriendlyTranscriptionErrorMessage: (error: unknown) => String(error),
}));
jest.mock('@/lib/transcriptAudio', () => ({
  deleteManagedTranscriptAudio: jest.fn(),
  retainTranscriptAudio: (...args: unknown[]) => mockRetainTranscriptAudio(...args),
}));
jest.mock('@/lib/permissions', () => ({ isNoSpeechError: () => false }));
jest.mock('expo-application', () => ({ applicationId: 'com.gizmolabs.openwhispr' }));
jest.mock('expo-clipboard', () => ({ setStringAsync: jest.fn() }));

import { AppGroupStorage } from '../../../modules/app-group-storage/src';
import { useKeyboardHandoff } from '../useKeyboardHandoff';

const storage = AppGroupStorage as unknown as {
  getItem: jest.Mock;
  setItem: jest.Mock;
  removeItem: jest.Mock;
  setKeyboardStatus: jest.Mock;
  startNativeRecording: jest.Mock;
};

function mountWithInitialUrl(url: string) {
  jest.spyOn(Linking, 'getInitialURL').mockResolvedValue(url);
  jest.spyOn(Linking, 'addEventListener').mockReturnValue(mockSubscription as never);
  return renderHook(() => useKeyboardHandoff());
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

beforeEach(() => {
  jest.clearAllMocks();
  storage.getItem.mockReturnValue(null);
  storage.startNativeRecording.mockReturnValue(true);
  mockCleanupTranscript.mockResolvedValue('clean transcript');
  mockTranscribeAndCleanup.mockResolvedValue({
    text: 'clean transcript',
    originalText: 'raw transcript',
    transcription: { text: 'raw transcript', duration: 1, provider: 'cloud' },
  });
  mockRetainTranscriptAudio.mockResolvedValue('file://retained.m4a');
  mockAnalyzeSpeechActivity.mockResolvedValue(null);
  mockRecordingStoppedListener = undefined;
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('useKeyboardHandoff — keyboard-full-access route', () => {
  // The recovery deep link belongs to expo-router. It reaches this hook like any
  // other openwhispr:// URL, and must fall straight through: a keyboard with no
  // Full Access has nothing to record with.
  it('starts no recording and writes no handoff state', async () => {
    mountWithInitialUrl('openwhispr://keyboard-full-access?source=keyboard');

    await waitFor(() => expect(mockHandoffStoreState.setCheckingInitialUrl).toHaveBeenCalled());

    expect(storage.startNativeRecording).not.toHaveBeenCalled();
    expect(storage.setKeyboardStatus).not.toHaveBeenCalled();
    expect(storage.setItem).not.toHaveBeenCalled();
    expect(storage.removeItem).not.toHaveBeenCalled();
    expect(mockHandoffStoreState.setActive).not.toHaveBeenCalled();
  });

  // The one side effect this route does own. Without it a concurrent warm resume
  // replaces the recovery screen with Home before the user ever sees it.
  it('stamps the recovery store so the warm resume cannot bounce the screen', async () => {
    mountWithInitialUrl('openwhispr://keyboard-full-access?source=keyboard');

    await waitFor(() => expect(mockMarkRecoveryDeepLink).toHaveBeenCalled());
  });

  // Control: the same harness on the dictation route does start a job, so the
  // assertions above are about the route and not about broken mocks.
  it('still starts a recording for the dictation route', async () => {
    mountWithInitialUrl('openwhispr://keyboard-dictation?source=keyboard');

    await waitFor(() => expect(storage.startNativeRecording).toHaveBeenCalled());
    expect(storage.setKeyboardStatus).toHaveBeenCalledWith('recording', null);
    expect(mockMarkRecoveryDeepLink).not.toHaveBeenCalled();
  });
});

describe('useKeyboardHandoff — orphaned keyboard transcript', () => {
  it('persists recovered history with the keyboard request context', async () => {
    storage.getItem.mockImplementation((key: string) => {
      if (key === 'keyboard_orphaned_raw_transcript') return 'raw transcript';
      if (key === 'keyboard_orphaned_raw_transcript_job_id') return '100-job';
      if (key === 'keyboard_recording_job_id') return '100-job';
      return null;
    });

    mountWithInitialUrl('openwhispr://ignored');

    await waitFor(() => expect(mockAddTranscript).toHaveBeenCalled());
    expect(mockAddTranscript).toHaveBeenCalledWith({
      text: 'clean transcript',
      originalText: 'raw transcript',
      provider: 'cloud',
      requestContext: 'keyboard',
    });
  });

  it('does not persist history when cancellation arrives during cleanup', async () => {
    const cleanup = deferred<string>();
    let cancelRequested = false;
    mockCleanupTranscript.mockReturnValueOnce(cleanup.promise);
    storage.getItem.mockImplementation((key: string) => {
      if (key === 'keyboard_orphaned_raw_transcript') return 'raw transcript';
      if (key === 'keyboard_orphaned_raw_transcript_job_id') return '100-job';
      if (key === 'keyboard_recording_job_id') return '100-job';
      if (key === 'keyboard_cancel_requested' && cancelRequested) return '1';
      return null;
    });

    mountWithInitialUrl('openwhispr://ignored');
    await waitFor(() => expect(mockCleanupTranscript).toHaveBeenCalled());

    cancelRequested = true;
    cleanup.resolve('clean transcript');
    await cleanup.promise;
    await waitFor(() =>
      expect(storage.removeItem).toHaveBeenCalledWith('keyboard_orphaned_raw_transcript'),
    );

    expect(mockAddTranscript).not.toHaveBeenCalled();
  });
});

describe('useKeyboardHandoff — cancelled keyboard transcription', () => {
  it('does not persist a completion when cancellation is requested', async () => {
    storage.getItem.mockImplementation((key: string) => {
      if (key === 'keyboard_cancel_requested') return '1';
      if (key === 'keyboard_recording_job_id') return '100-job';
      return null;
    });
    mountWithInitialUrl('openwhispr://ignored');

    await act(async () => {
      await mockRecordingStoppedListener?.({
        fileUri: 'file://recording.m4a',
        fileName: 'recording.m4a',
        mimeType: 'audio/m4a',
        recordingFormat: 'm4a',
        jobId: '100-job',
        fileSizeBytes: 100,
        recordingDurationMs: 1000,
      });
    });

    expect(mockTranscribeAndCleanup).not.toHaveBeenCalled();
    expect(mockAddTranscript).not.toHaveBeenCalled();
  });
});

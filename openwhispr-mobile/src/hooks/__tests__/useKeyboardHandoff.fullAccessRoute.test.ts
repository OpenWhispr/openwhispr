jest.mock('@/lib/keyboardInferenceRoute', () => ({
  snapshotKeyboardInferenceRoute: jest.fn(),
  readKeyboardInferenceRoute: jest.fn(() => ({ provider: 'cloud' })),
  readKeyboardProviderResult: jest.fn(),
  clearKeyboardProviderRecovery: jest.fn(),
}));
jest.mock('@/lib/inferenceRouting', () => ({
  snapshotTranscriptionJob: () => ({ provider: 'cloud' }),
}));
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
const mockAddFailedTranscript = jest.fn();
const mockCleanupTranscript = jest.fn();
const mockTranscribeAndCleanup = jest.fn();
const mockTranscribe = jest.fn();
const mockRetainTranscriptAudio = jest.fn();
const mockAnalyzeSpeechActivity = jest.fn();
let mockRecordingStoppedListener: ((event: RecordingStoppedEvent) => Promise<void>) | undefined;
let mockBackgroundStartedListener: (() => void) | undefined;

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
    stopNativeRecording: jest.fn(),
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
  addBackgroundRecordingStartedListener: (listener: () => void) => {
    mockBackgroundStartedListener = listener;
    return mockSubscription;
  },
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
    getState: () => ({
      addTranscript: mockAddTranscript,
      addFailedTranscript: mockAddFailedTranscript,
      transcripts: [],
      load: jest.fn(),
    }),
  },
}));
jest.mock('@/store/useSnippetsStore', () => ({
  useSnippetsStore: { getState: () => ({ snippets: [] }) },
}));
jest.mock('@/services/transcription/TranscriptionService', () => ({
  TranscriptionService: {
    prepareLocal: jest.fn(() => Promise.resolve()),
    transcribe: (...args: unknown[]) => mockTranscribe(...args),
  },
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
  deleteManagedTranscriptAudio: jest.fn(async () => undefined),
  retainTranscriptAudio: (...args: unknown[]) => mockRetainTranscriptAudio(...args),
}));
jest.mock('@/lib/permissions', () => ({ isNoSpeechError: () => false }));
jest.mock('expo-application', () => ({ applicationId: 'com.gizmolabs.openwhispr' }));
jest.mock('expo-clipboard', () => ({ setStringAsync: jest.fn() }));

import { AppGroupStorage } from '../../../modules/app-group-storage/src';
import {
  readKeyboardProviderResult,
  readKeyboardInferenceRoute,
  clearKeyboardProviderRecovery,
  snapshotKeyboardInferenceRoute,
} from '@/lib/keyboardInferenceRoute';
import { readKeyboardAgentJob, snapshotKeyboardAgentRequest } from '@/lib/keyboardAgentSync';
import { withActiveProviderJob } from '@/lib/providerJobActivity';
import { useKeyboardHandoff } from '../useKeyboardHandoff';

const storage = AppGroupStorage as unknown as {
  getItem: jest.Mock;
  setItem: jest.Mock;
  removeItem: jest.Mock;
  setKeyboardStatus: jest.Mock;
  startNativeRecording: jest.Mock;
  stopNativeRecording: jest.Mock;
  returnToPreviousApp: jest.Mock;
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
  // clearAllMocks keeps mockReturnValue overrides; reset the ones tests override.
  (readKeyboardProviderResult as jest.Mock).mockReset();
  (readKeyboardInferenceRoute as jest.Mock).mockImplementation(() => ({ provider: 'cloud' }));
  (readKeyboardAgentJob as jest.Mock).mockReturnValue(null);
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
    expect(mockAddTranscript).toHaveBeenCalledWith(
      expect.objectContaining({
        text: 'clean transcript',
        originalText: 'raw transcript',
        provider: 'cloud',
        requestContext: 'keyboard',
      }),
    );
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

  it('keeps a newer job orphan slot when an older orphan cleanup goes stale', async () => {
    const cleanup = deferred<string>();
    let newerJobStarted = false;
    mockCleanupTranscript.mockReturnValueOnce(cleanup.promise);
    storage.getItem.mockImplementation((key: string) => {
      const jobId = newerJobStarted ? '200-job' : '100-job';
      if (key === 'keyboard_orphaned_raw_transcript') return 'raw transcript';
      if (key === 'keyboard_orphaned_raw_transcript_job_id') return jobId;
      if (key === 'keyboard_recording_job_id') return jobId;
      return null;
    });

    mountWithInitialUrl('openwhispr://ignored');
    await waitFor(() => expect(mockCleanupTranscript).toHaveBeenCalled());

    newerJobStarted = true;
    cleanup.resolve('clean transcript');
    await cleanup.promise;
    await waitFor(() => expect(clearKeyboardProviderRecovery).toHaveBeenCalledWith('100-job'));

    expect(storage.removeItem).not.toHaveBeenCalledWith('keyboard_orphaned_raw_transcript');
    expect(storage.removeItem).not.toHaveBeenCalledWith('keyboard_orphaned_raw_transcript_job_id');
    expect(mockAddTranscript).not.toHaveBeenCalled();
  });

  it('uses the per-job route snapshot to clean a Cloud orphan', async () => {
    (readKeyboardInferenceRoute as jest.Mock).mockReturnValue({
      provider: 'cloud',
      cleanupRoute: { mode: 'openwhispr', scope: 'cleanup' },
    });
    storage.getItem.mockImplementation((key: string) => {
      if (key === 'keyboard_orphaned_raw_transcript') return 'raw transcript';
      if (key === 'keyboard_orphaned_raw_transcript_job_id') return '100-job';
      if (key === 'keyboard_recording_job_id') return '100-job';
      return null;
    });
    mockCleanupTranscript.mockResolvedValue('Cleaned transcript.');

    mountWithInitialUrl('openwhispr://ignored');

    await waitFor(() => expect(mockCleanupTranscript).toHaveBeenCalled());
    expect(readKeyboardInferenceRoute).toHaveBeenCalledWith('100-job');
    await waitFor(() =>
      expect(mockAddTranscript).toHaveBeenCalledWith(
        expect.objectContaining({ text: 'Cleaned transcript.', cleanupWarning: undefined }),
      ),
    );
  });

  it('drops a stale orphan once and clears its recovery keys', async () => {
    storage.getItem.mockImplementation((key: string) => {
      if (key === 'keyboard_orphaned_raw_transcript') return 'raw transcript';
      if (key === 'keyboard_orphaned_raw_transcript_job_id') return '100-job';
      if (key === 'keyboard_recording_job_id') return '200-job';
      return null;
    });

    mountWithInitialUrl('openwhispr://ignored');

    await waitFor(() =>
      expect(storage.removeItem).toHaveBeenCalledWith('keyboard_orphaned_raw_transcript_job_id'),
    );
    expect(mockCleanupTranscript).not.toHaveBeenCalled();
    expect(clearKeyboardProviderRecovery).toHaveBeenCalledWith('100-job');
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

describe('provider upload recovery', () => {
  it('saves native raw text and original provider route before clearing durable recovery', async () => {
    const route = {
      provider: 'byok',
      inferenceRoute: {
        mode: 'providers',
        scope: 'dictation',
        providerId: 'groq',
        modelId: 'whisper-large-v3-turbo',
        endpoint: 'https://api.groq.com/openai/v1',
      },
      cleanupUnavailable: 'Cleanup unavailable',
    };
    (readKeyboardProviderResult as jest.Mock).mockReturnValueOnce({
      text: 'provider raw words',
      route,
    });
    storage.getItem.mockImplementation((key: string) =>
      key === 'keyboard_recording_job_id'
        ? 'recovered-job'
        : key === 'keyboard_upload_audio.recovered-job'
          ? 'file://saved.m4a'
          : null,
    );
    mountWithInitialUrl('openwhispr://ignored');
    await waitFor(() => expect(mockAddTranscript).toHaveBeenCalled());
    expect(mockAddTranscript).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'recovered-job',
        originalText: 'provider raw words',
        provider: 'byok',
        inferenceRoute: route.inferenceRoute,
        audioUrl: 'file://saved.m4a',
      }),
    );
    expect(mockCleanupTranscript).toHaveBeenCalledWith(
      'provider raw words',
      expect.objectContaining({ requireProvider: true, cleanupUnavailable: 'Cleanup unavailable' }),
    );
    expect(clearKeyboardProviderRecovery).toHaveBeenCalledWith('recovered-job');
  });
  it('retains provider result metadata if durable history saving fails', async () => {
    (readKeyboardProviderResult as jest.Mock).mockReturnValueOnce({
      text: 'provider raw words',
      route: { provider: 'byok' },
    });
    mockAddTranscript.mockRejectedValueOnce(new Error('storage failed'));
    storage.getItem.mockImplementation((key: string) =>
      key === 'keyboard_recording_job_id' ? 'recovered-job' : null,
    );
    mountWithInitialUrl('openwhispr://ignored');
    await waitFor(() =>
      expect(storage.setKeyboardStatus).toHaveBeenCalledWith('error', 'storage failed'),
    );
    expect(clearKeyboardProviderRecovery).not.toHaveBeenCalled();
  });
  it('saves an interrupted upload as retryable using its original route', async () => {
    const route = {
      provider: 'byok',
      inferenceRoute: { mode: 'providers', scope: 'dictation', providerId: 'groq' },
    };
    (readKeyboardInferenceRoute as jest.Mock).mockReturnValueOnce(route);
    storage.getItem.mockImplementation((key: string) =>
      key === 'keyboard_recording_job_id'
        ? 'interrupted-job'
        : key === 'keyboard_upload_audio.interrupted-job'
          ? 'file://original.m4a'
          : null,
    );
    mountWithInitialUrl('openwhispr://ignored');
    await waitFor(() => expect(mockAddFailedTranscript).toHaveBeenCalled());
    expect(mockAddFailedTranscript).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'interrupted-job', audioUrl: 'file://original.m4a', ...route }),
    );
    expect(mockTranscribeAndCleanup).not.toHaveBeenCalled();
  });
});

it('discards interrupted provider data when keyboard cancellation rejects transcription', async () => {
  let cancelled = false;
  storage.getItem.mockImplementation((key: string) => {
    if (key === 'keyboard_recording_job_id') return '100-job';
    if (key === 'keyboard_cancel_requested' && cancelled) return '1';
    return null;
  });
  mockTranscribeAndCleanup.mockImplementationOnce(async () => {
    cancelled = true;
    throw new Error('The provider request was cancelled.');
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
  expect(mockTranscribeAndCleanup).toHaveBeenCalled();
  expect(mockAddFailedTranscript).not.toHaveBeenCalled();
  expect(mockAddTranscript).not.toHaveBeenCalled();
  expect(clearKeyboardProviderRecovery).toHaveBeenCalledWith('100-job');
});

describe('keyboard agent job', () => {
  it('keeps a provider instruction out of relaunch recovery and composes on its own route', async () => {
    const { generateForJob } = jest.requireMock('@/services/agent/AgentComposerService');
    const agentRoute = {
      mode: 'providers',
      scope: 'agent',
      providerId: 'openai',
      modelId: 'gpt-4o-mini',
      endpoint: 'https://api.openai.com/v1',
    };
    (readKeyboardInferenceRoute as jest.Mock).mockReturnValue({ provider: 'byok', agentRoute });
    const agentJob = { jobId: '100-job', sessionId: 's', kind: 'compose' };
    (readKeyboardAgentJob as jest.Mock).mockImplementation((id: string) =>
      id === '100-job' ? agentJob : null,
    );
    storage.getItem.mockImplementation((key: string) =>
      key === 'keyboard_recording_job_id' ? '100-job' : null,
    );
    mockTranscribe.mockResolvedValue({ text: 'write an email to Bob', provider: 'byok' });
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
    expect(mockTranscribe).toHaveBeenCalledWith(expect.not.objectContaining({ jobId: '100-job' }));
    expect(generateForJob).toHaveBeenCalledWith(
      agentJob,
      'write an email to Bob',
      expect.objectContaining({ agentRoute }),
    );
    expect(mockAddTranscript).not.toHaveBeenCalled();
  });
});

const stopEvent = (jobId: string): RecordingStoppedEvent => ({
  fileUri: 'file://recording.m4a',
  fileName: 'recording.m4a',
  mimeType: 'audio/m4a',
  recordingFormat: 'm4a',
  jobId,
  fileSizeBytes: 100,
  recordingDurationMs: 1000,
});

describe('provider job lifecycle', () => {
  it('leaves a provider upload still running in this process to its own job', async () => {
    let finishRunningJob!: () => void;
    const runningJob = withActiveProviderJob(
      'running-job',
      () => new Promise<void>((resolve) => (finishRunningJob = resolve)),
    );
    (readKeyboardInferenceRoute as jest.Mock).mockReturnValue({ provider: 'byok' });
    storage.getItem.mockImplementation((key: string) =>
      key === 'keyboard_recording_job_id'
        ? 'running-job'
        : key === 'keyboard_upload_audio.running-job'
          ? 'file://running.m4a'
          : null,
    );
    mountWithInitialUrl('openwhispr://ignored');
    await waitFor(() => expect(mockHandoffStoreState.setCheckingInitialUrl).toHaveBeenCalled());
    await act(async () => undefined);
    expect(mockAddFailedTranscript).not.toHaveBeenCalled();
    expect(clearKeyboardProviderRecovery).not.toHaveBeenCalled();
    finishRunningJob();
    await runningJob;
  });

  it('clears recovery data for a transcript superseded by a newer job', async () => {
    let activeJobId = '100-job';
    storage.getItem.mockImplementation((key: string) =>
      key === 'keyboard_recording_job_id' ? activeJobId : null,
    );
    mockTranscribeAndCleanup.mockImplementationOnce(async () => {
      activeJobId = '200-job';
      return {
        text: 'clean transcript',
        originalText: 'raw transcript',
        transcription: { text: 'raw transcript', duration: 1, provider: 'byok' },
      };
    });
    mountWithInitialUrl('openwhispr://ignored');
    await act(async () => {
      await mockRecordingStoppedListener?.(stopEvent('100-job'));
    });
    expect(mockAddTranscript).not.toHaveBeenCalled();
    expect(clearKeyboardProviderRecovery).toHaveBeenCalledWith('100-job');
  });

  it('returns to the previous app when the recording route cannot be set up', async () => {
    (snapshotKeyboardInferenceRoute as jest.Mock).mockImplementationOnce(() => {
      throw new Error('setup incomplete');
    });
    mountWithInitialUrl('openwhispr://keyboard-dictation?source=keyboard');
    await waitFor(() =>
      expect(storage.setKeyboardStatus).toHaveBeenCalledWith(
        'error',
        'Complete provider setup in AI Models.',
      ),
    );
    expect(storage.returnToPreviousApp).toHaveBeenCalled();
    expect(snapshotKeyboardAgentRequest).toHaveBeenCalled();
    expect(storage.startNativeRecording).not.toHaveBeenCalled();
  });

  it('stops a warm-mic recording whose route cannot be set up', async () => {
    (readKeyboardInferenceRoute as jest.Mock).mockReturnValue(undefined);
    (snapshotKeyboardInferenceRoute as jest.Mock).mockImplementationOnce(() => {
      throw new Error('setup incomplete');
    });
    storage.getItem.mockImplementation((key: string) =>
      key === 'keyboard_recording_job_id' ? '300-job' : null,
    );
    mountWithInitialUrl('openwhispr://ignored');
    await waitFor(() => expect(mockBackgroundStartedListener).toBeDefined());
    act(() => mockBackgroundStartedListener?.());
    expect(snapshotKeyboardAgentRequest).toHaveBeenCalledWith('300-job');
    expect(storage.stopNativeRecording).toHaveBeenCalled();
  });

  it('refuses an agent command with no agent provider before transcribing it', async () => {
    const { generateForJob } = jest.requireMock('@/services/agent/AgentComposerService');
    (readKeyboardInferenceRoute as jest.Mock).mockReturnValue({
      provider: 'byok',
      agentUnavailable: 'The voice assistant is unavailable. Your raw transcript is saved.',
    });
    const agentJob = { jobId: '100-job', sessionId: 's', kind: 'compose' };
    (readKeyboardAgentJob as jest.Mock).mockImplementation((id: string) =>
      id === '100-job' ? agentJob : null,
    );
    storage.getItem.mockImplementation((key: string) =>
      key === 'keyboard_recording_job_id' ? '100-job' : null,
    );
    mountWithInitialUrl('openwhispr://ignored');
    await act(async () => {
      await mockRecordingStoppedListener?.(stopEvent('100-job'));
    });
    expect(mockTranscribe).not.toHaveBeenCalled();
    expect(generateForJob).not.toHaveBeenCalled();
    expect(storage.setKeyboardStatus).toHaveBeenCalledWith('agent_error', 'agent_setup_required');
  });
});

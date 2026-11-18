// The dashboard's dictation_completed fact as the app's own recorder reports it.
import { act, renderHook } from '@testing-library/react-native';
import { useAudioRecording, type UseAudioRecordingOptions } from '../useAudioRecording';
import { transcribeAndCleanup } from '@/lib/transcribeAndCleanup';
import { isLocalModelMissingError } from '@/services/transcription/TranscriptionService';
import { isUsageLimitError } from '@/lib/usageLimitError';
import { recordDictationCompleted } from '@/lib/productEvents';
import {
  CAPTURE_ACCOUNT,
  NEXT_ACCOUNT,
  createProductEventsCaptureRig,
} from './helpers/productEventsCaptureRig';

jest.mock('expo-file-system/legacy', () => ({
  getInfoAsync: jest.fn(async () => ({ exists: true, size: 1024 })),
  deleteAsync: jest.fn(async () => undefined),
}));

// permissions.ts re-exports the alert helper, which reaches nativewind through
// the UI layer — untransformable here and irrelevant to the branch under test.
jest.mock('@/components/ui/PermissionAlert', () => ({ showPermissionAlert: jest.fn() }));

const mockAddTranscript = jest.fn(async () => undefined);
const mockAddFailedTranscript = jest.fn(async () => undefined);
jest.mock('@/store/useTranscriptStore', () => ({
  createTranscriptId: jest.fn(() => 'test-id'),
  useTranscriptStore: (selector: (state: unknown) => unknown) =>
    selector({ addTranscript: mockAddTranscript, addFailedTranscript: mockAddFailedTranscript }),
}));

jest.mock('@/lib/inferenceRouting', () => ({
  snapshotTranscriptionJob: () => ({ provider: 'local' }),
  snapshotTextInference: () => ({}),
}));

jest.mock('@/lib/transcribeAndCleanup', () => ({ transcribeAndCleanup: jest.fn() }));
jest.mock('@/services/transcription/TranscriptionService', () => ({
  isLocalModelMissingError: jest.fn(() => false),
}));
jest.mock('@/lib/speechActivity', () => ({
  analyzeSpeechActivity: jest.fn(async () => null),
  createNoSpeechError: jest.fn(() => new Error('No speech detected')),
}));
jest.mock('@/lib/transcriptAudio', () => ({
  retainTranscriptAudio: jest.fn(async () => 'file:///docs/transcript-audio/test-id.wav'),
  deleteManagedTranscriptAudio: jest.fn(async () => undefined),
}));
jest.mock('@/lib/usageLimitError', () => ({ isUsageLimitError: jest.fn(() => false) }));
let mockProductEvents: ReturnType<typeof createProductEventsCaptureRig>;
jest.mock('@/lib/productEvents', () => ({
  ...jest.requireActual('@/lib/productEvents'),
  captureDictationContext: () => mockProductEvents.events.captureDictationContext(),
  recordDictationCompleted: jest.fn(
    (dictation: Parameters<typeof recordDictationCompleted>[0]): void => {
      mockProductEvents.pending.push(mockProductEvents.events.recordDictationCompleted(dictation));
    },
  ),
}));
jest.mock('expo-crypto', () => ({
  CryptoDigestAlgorithm: { SHA256: 'SHA-256' },
  digestStringAsync: async (_algorithm: string, value: string): Promise<string> =>
    jest.requireActual('node:crypto').createHash('sha256').update(value).digest('hex'),
  randomUUID: jest.requireActual('node:crypto').randomUUID,
}));
jest.mock('@/lib/transcriptionLanguage', () => ({
  getPreferredTranscriptionLanguage: jest.fn(() => 'en'),
}));

// jest hoists mock factories above the module body, so anything they close over
// has to be mock-prefixed to survive the hoist.
const mockRecorder = {
  isRecording: false,
  uri: 'file:///tmp/rec.wav',
  prepareToRecordAsync: jest.fn(async () => undefined),
  record: jest.fn(),
  stop: jest.fn(async () => undefined),
};

const mockAudioModule = {
  getRecordingPermissionsAsync: jest.fn(async () => ({ granted: true })),
  requestRecordingPermissionsAsync: jest.fn(async () => ({ granted: true })),
  requestNotificationPermissionsAsync: jest.fn(async () => ({ granted: true })),
  setAudioModeAsync: jest.fn(async () => undefined),
};

jest.mock('expo-audio', () => ({ useAudioRecorder: () => mockRecorder }));
jest.mock('@/utils/expoAudio', () => ({
  getExpoAudioModule: () => ({ AudioModule: mockAudioModule }),
  isExpoAudioAvailable: () => true,
  getDefaultRecorderOptions: () => ({}),
}));

const mockTranscribe = jest.mocked(transcribeAndCleanup);

const transcribed = (
  text: string,
  originalText = text,
  provider = 'cloud',
): Awaited<ReturnType<typeof transcribeAndCleanup>> =>
  ({
    text,
    originalText,
    transcription: { duration: 1, provider },
  }) as Awaited<ReturnType<typeof transcribeAndCleanup>>;

async function recordAndStop(options: UseAudioRecordingOptions): Promise<{ stopError: unknown }> {
  const { result } = renderHook(() => useAudioRecording(options));
  await act(async () => {
    await result.current.startRecording();
  });
  mockRecorder.isRecording = true;
  let stopError: unknown;
  await act(async () => {
    await result.current.stopRecording().catch((error: unknown) => {
      stopError = error;
    });
  });
  return { stopError };
}

beforeEach(() => {
  mockProductEvents = createProductEventsCaptureRig();
  jest.clearAllMocks();
  mockTranscribe.mockReset();
  jest.mocked(isLocalModelMissingError).mockReturnValue(false);
  jest.mocked(isUsageLimitError).mockReturnValue(false);
  mockRecorder.isRecording = false;
});

afterEach(async (): Promise<void> => {
  await mockProductEvents.settle();
});

const mockRecordDictation = jest.mocked(recordDictationCompleted);

it('original dictation reports its words as heard, before cleanup and snippets', async () => {
  mockTranscribe.mockResolvedValue(
    transcribed('Meet Dana at three. Best regards, Josh', 'meet dana at three', 'local'),
  );

  await recordAndStop({ recordsDictation: true });

  expect(mockRecordDictation).toHaveBeenCalledTimes(1);
  expect(mockRecordDictation).toHaveBeenCalledWith({
    context: expect.any(Object),
    captureId: expect.stringMatching(/^recording-[0-9a-f-]{36}$/),
    words: 4,
    provider: 'local',
    source: 'dictation',
    retranscribe: false,
  });
});

it('a recording that is not original dictation reports nothing', async () => {
  mockTranscribe.mockResolvedValue(transcribed('What is on my calendar?'));

  await recordAndStop({ saveToHistory: false, cleanup: false, onComplete: jest.fn() });

  expect(mockRecordDictation).not.toHaveBeenCalled();
});

it('a cloud retry of a recording the phone could not transcribe is a re-transcription', async () => {
  const missing = new Error('Local model missing');
  mockTranscribe.mockRejectedValueOnce(missing).mockResolvedValueOnce(transcribed('Retried.'));
  jest.mocked(isLocalModelMissingError).mockImplementation((error) => error === missing);
  let retryWithCloud: (() => void) | undefined;

  await recordAndStop({
    recordsDictation: true,
    onLocalModelMissing: (retry) => {
      retryWithCloud = retry;
    },
  });
  expect(mockRecordDictation).not.toHaveBeenCalled();

  await act(async () => {
    retryWithCloud?.();
  });

  expect(mockRecordDictation).toHaveBeenCalledWith(
    expect.objectContaining({ words: 1, provider: 'cloud', retranscribe: true }),
  );
});

it('a cancelled, failed or silent recording reports nothing', async () => {
  let cancelled = false;
  mockTranscribe.mockImplementationOnce(async () => {
    cancelled = true;
    return transcribed('Dropped.');
  });
  await recordAndStop({ recordsDictation: true, shouldCancel: () => cancelled });

  mockTranscribe.mockRejectedValueOnce(new Error('Network down'));
  await recordAndStop({ recordsDictation: true, onError: jest.fn() });

  mockTranscribe.mockResolvedValueOnce(transcribed('   '));
  await recordAndStop({ recordsDictation: true, onError: jest.fn() });

  expect(mockRecordDictation).not.toHaveBeenCalled();
});

it.each([null, { userId: 'anonymous', isAnonymous: true, cookie: 'anonymous-cookie' }])(
  'does not count words captured before signup after their delayed completion',
  async (guest): Promise<void> => {
    await mockProductEvents.signInAs(guest);
    let finishTranscribing!: (result: Awaited<ReturnType<typeof transcribeAndCleanup>>) => void;
    mockTranscribe.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishTranscribing = resolve;
        }),
    );
    const onComplete = jest.fn();
    const hook = renderHook(() => useAudioRecording({ recordsDictation: true, onComplete }));
    await act(async () => {
      await hook.result.current.startRecording();
    });
    mockRecorder.isRecording = true;
    let stopping!: Promise<void>;
    await act(async () => {
      stopping = hook.result.current.stopRecording();
    });
    hook.unmount();
    await mockProductEvents.signInAs(NEXT_ACCOUNT);
    await act(async () => {
      finishTranscribing(transcribed('Saved words.', 'spoken before signup'));
      await stopping;
    });
    await mockProductEvents.settle();

    expect(onComplete).toHaveBeenCalledWith('Saved words.');
    expect(mockProductEvents.dictations()).toEqual([]);
    expect(mockProductEvents.countedWords()).toEqual({});
  },
);

it('keeps the account from recording start when another account owns stop and completion', async (): Promise<void> => {
  mockTranscribe.mockResolvedValue(transcribed('Saved words.', 'spoken by first account'));
  const hook = renderHook(() => useAudioRecording({ recordsDictation: true }));
  await act(async () => {
    await hook.result.current.startRecording();
  });
  mockRecorder.isRecording = true;
  await mockProductEvents.signInAs(NEXT_ACCOUNT);
  await act(async () => {
    await hook.result.current.stopRecording();
  });
  await mockProductEvents.settle();

  expect(mockProductEvents.dictations()).toEqual([]);
  expect(mockProductEvents.queuedDictations()).toEqual([
    expect.objectContaining({ owner_user_id: 'capture-account' }),
  ]);
  expect(mockProductEvents.countedWords()).toEqual({ 'capture-account': 4 });
  await mockProductEvents.signInAs(CAPTURE_ACCOUNT);
  await mockProductEvents.settle();
  expect(mockProductEvents.dictations()).toEqual([
    {
      owner: 'capture-account',
      cookie: 'capture-cookie',
      properties: expect.objectContaining({ word_count: 4 }),
    },
  ]);
});

it('keeps a practice capture excluded after onboarding finishes', async (): Promise<void> => {
  mockProductEvents.setPractice(true);
  mockTranscribe.mockResolvedValue(transcribed('Practice words.'));
  const hook = renderHook(() => useAudioRecording({ recordsDictation: true }));
  await act(async () => {
    await hook.result.current.startRecording();
  });
  mockRecorder.isRecording = true;
  mockProductEvents.setPractice(false);
  await act(async () => {
    await hook.result.current.stopRecording();
  });
  await mockProductEvents.settle();

  expect(mockProductEvents.dictations()).toEqual([
    expect.objectContaining({ properties: expect.objectContaining({ is_practice: true }) }),
  ]);
  expect(mockProductEvents.countedWords()).toEqual({});
});

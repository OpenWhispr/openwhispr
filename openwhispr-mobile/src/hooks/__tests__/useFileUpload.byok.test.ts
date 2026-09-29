import { act, renderHook } from '@testing-library/react-native';

const mockGetDocumentAsync = jest.fn();
const mockGetInfoAsync = jest.fn();
const mockSnapshotTranscriptionJob = jest.fn();
const mockTranscribeAndCleanup = jest.fn();
const mockRetainTranscriptAudio = jest.fn();
const mockAddTranscript = jest.fn();
const mockAddFailedTranscript = jest.fn();

jest.mock('expo-document-picker', () => ({
  getDocumentAsync: (...args: unknown[]): unknown => mockGetDocumentAsync(...args),
}));
jest.mock('expo-file-system/legacy', () => ({
  getInfoAsync: (...args: unknown[]): unknown => mockGetInfoAsync(...args),
}));
jest.mock('../../../modules/audio-tools/src', () => ({
  AudioTools: { isAvailable: () => false, cleanup: jest.fn(async () => undefined) },
}));
jest.mock('../../services/transcription/TranscriptionService', () => ({
  isOggOpus: () => false,
  isLocalModelMissingError: () => false,
}));
jest.mock('../../store/useTranscriptStore', () => ({
  createTranscriptId: () => 'upload-1',
  useTranscriptStore: (selector: (state: unknown) => unknown): unknown =>
    selector({ addTranscript: mockAddTranscript, addFailedTranscript: mockAddFailedTranscript }),
}));
jest.mock('../../lib/inferenceRouting', () => ({
  snapshotTranscriptionJob: (scope: string): unknown => mockSnapshotTranscriptionJob(scope),
  snapshotTextInference: () => ({}),
}));
jest.mock('../../lib/transcribeAndCleanup', () => ({
  transcribeAndCleanup: (...args: unknown[]): unknown => mockTranscribeAndCleanup(...args),
}));
jest.mock('../../lib/transcriptionLanguage', () => ({
  getPreferredTranscriptionLanguage: () => 'en',
}));
jest.mock('../../lib/permissions', () => ({ isNoSpeechError: () => false }));
jest.mock('../../lib/transcriptAudio', () => ({
  retainTranscriptAudio: (...args: unknown[]): unknown => mockRetainTranscriptAudio(...args),
  deleteManagedTranscriptAudio: jest.fn(async () => undefined),
}));

import { useFileUpload } from '../useFileUpload';

const byokRoute = {
  provider: 'byok',
  inferenceRoute: {
    mode: 'providers',
    scope: 'upload',
    providerId: 'openai',
    modelId: 'whisper-1',
    endpoint: 'https://api.openai.com/v1',
    credentialRef: 'provider.openai',
  },
};
const MB = 1024 * 1024;

function pick(asset: { name: string; mimeType?: string; size?: number }): void {
  mockGetDocumentAsync.mockResolvedValue({
    canceled: false,
    assets: [{ uri: `file://picked/${asset.name}`, ...asset }],
  });
}

async function upload(): Promise<{ error?: Error; onError: jest.Mock }> {
  const onError = jest.fn();
  const { result } = renderHook(() => useFileUpload({ onError }));
  let error: Error | undefined;
  await act(async () => {
    await result.current.pickAndTranscribeFile().catch((thrown: Error) => {
      error = thrown;
    });
  });
  return { error, onError };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockSnapshotTranscriptionJob.mockReturnValue(byokRoute);
  mockGetInfoAsync.mockResolvedValue({ exists: true, size: 1 * MB });
  mockRetainTranscriptAudio.mockResolvedValue('file://docs/transcript-audio/upload-1.m4a');
  mockTranscribeAndCleanup.mockResolvedValue({
    text: 'hello',
    originalText: 'hello',
    transcription: { text: 'hello', provider: 'byok' },
  });
});

describe('provider uploads that the provider would reject', () => {
  it.each(['voice.aac', 'voice.opus'])('refuses %s before creating a job', async (name) => {
    pick({ name, size: 1 * MB });
    const { error } = await upload();
    expect(error?.message).toBe(
      'Your provider accepts FLAC, MP3, MP4, M4A, OGG, WAV, or WEBM audio. Choose a file in one of those formats.',
    );
    expect(mockRetainTranscriptAudio).not.toHaveBeenCalled();
    expect(mockAddFailedTranscript).not.toHaveBeenCalled();
    expect(mockTranscribeAndCleanup).not.toHaveBeenCalled();
  });

  it('refuses a file over 25 MB whose size the picker did not report', async () => {
    pick({ name: 'long.m4a' });
    mockGetInfoAsync.mockResolvedValue({ exists: true, size: 26 * MB });
    const { error } = await upload();
    expect(error?.message).toBe(
      'Your provider accepts audio files up to 25 MB. Choose a smaller file.',
    );
    expect(mockRetainTranscriptAudio).not.toHaveBeenCalled();
    expect(mockAddFailedTranscript).not.toHaveBeenCalled();
  });

  it('sends a supported file within the limit to the provider', async () => {
    pick({ name: 'voice.m4a' });
    const { error } = await upload();
    expect(error).toBeUndefined();
    expect(mockTranscribeAndCleanup).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'byok', inferenceRoute: byokRoute.inferenceRoute }),
      expect.anything(),
    );
  });

  it('still lets OpenWhispr Cloud take AAC uploads', async () => {
    mockSnapshotTranscriptionJob.mockReturnValue({ provider: 'cloud' });
    pick({ name: 'voice.aac', size: 1 * MB });
    const { error } = await upload();
    expect(error).toBeUndefined();
    expect(mockTranscribeAndCleanup).toHaveBeenCalled();
  });
});

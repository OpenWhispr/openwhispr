import * as FileSystem from 'expo-file-system/legacy';
import { BackgroundUploader } from '../../../../modules/background-uploader/src';
import { AudioTools } from '../../../../modules/audio-tools/src';
import { TranscriptionService } from '../TranscriptionService';
import type { TranscriptionRequest } from '../../../types';

jest.mock('expo-constants', () => ({
  __esModule: true,
  default: { expoConfig: { version: '1.2.1' } },
}));
jest.mock('expo/fetch', () => ({ fetch: jest.fn() }));
jest.mock('@/store/useAuthStore', () => ({
  useAuthStore: { getState: () => ({ sessionCookie: 'test-session-cookie' }) },
}));
jest.mock('expo-file-system/legacy', () => ({
  getInfoAsync: jest.fn(),
  uploadAsync: jest.fn(),
  FileSystemUploadType: { MULTIPART: 1 },
  FileSystemSessionType: { FOREGROUND: 0 },
}));
jest.mock('../LocalWhisperService', () => ({ LocalWhisperService: {} }));
jest.mock('../LocalTranscriptionService', () => ({ LocalTranscriptionService: {} }));
jest.mock('@/lib/dictationHints', () => ({
  buildDictationHintTiers: () => [[], [], []],
  buildLlmDictionary: () => ({ personal: [], shared: [] }),
  isDictationContext: () => true,
}));
jest.mock('@/lib/cleanupTranscript', () => ({ CLEANUP_TIMEOUT_MS: 30000 }));
jest.mock('../../../../modules/background-uploader/src', () => ({
  BackgroundUploader: { isAvailable: () => true, upload: jest.fn() },
}));
jest.mock('../../../../modules/audio-tools/src', () => ({
  AudioTools: {
    isAvailable: () => true,
    splitToChunks: jest.fn(),
    splitOggOpus: jest.fn(),
    cleanup: jest.fn(),
  },
}));
jest.mock('../../../../modules/app-group-storage/src', () => ({
  AppGroupStorage: {},
  APP_GROUP_KEYS: {},
}));

beforeEach((): void => {
  jest.clearAllMocks();
  jest.mocked(FileSystem.getInfoAsync).mockResolvedValue({
    exists: true,
    isDirectory: false,
    uri: 'file:///recording.wav',
    size: 1024,
    modificationTime: 0,
  });
  const response = {
    status: 200,
    body: JSON.stringify({ text: 'Hello world.' }),
    headers: {},
    mimeType: null,
  };
  jest.mocked(FileSystem.uploadAsync).mockResolvedValue(response);
  jest.mocked(BackgroundUploader.upload).mockResolvedValue(response);
  jest.mocked(AudioTools.splitToChunks).mockResolvedValue({
    chunks: ['file:///chunk.wav'],
    durationMs: 1000,
  });
});

describe.each(['keyboard', 'recording'] as const)('%s upload headers', (requestContext): void => {
  it.each([
    { cleanup: false, chunked: false },
    { cleanup: true, chunked: false },
    { cleanup: false, chunked: true },
  ])(
    'identifies mobile with cleanup=$cleanup and chunked=$chunked',
    async ({ cleanup, chunked }): Promise<void> => {
      if (chunked) {
        jest.mocked(FileSystem.getInfoAsync).mockResolvedValueOnce({
          exists: true,
          isDirectory: false,
          uri: 'file:///recording.wav',
          size: 8 * 1024 * 1024,
          modificationTime: 0,
        });
      }
      const request: TranscriptionRequest = {
        audioUri: 'file:///recording.wav',
        provider: 'cloud',
        requestContext,
      };
      const result = cleanup
        ? await TranscriptionService.transcribeWithCloudCleanup(request)
        : await TranscriptionService.transcribe(request);

      expect(result.text).toBe('Hello world.');
      const headers = expect.objectContaining({
        Cookie: 'test-session-cookie',
        'x-openwhispr-version': '1.2.1',
        'x-openwhispr-policy-version': '1',
        'x-openwhispr-platform': 'mobile',
      });
      if (requestContext === 'keyboard') {
        expect(FileSystem.uploadAsync).toHaveBeenCalledWith(
          expect.stringContaining('/api/transcribe'),
          chunked ? 'file:///chunk.wav' : request.audioUri,
          expect.objectContaining({ headers }),
        );
        expect(BackgroundUploader.upload).not.toHaveBeenCalled();
      } else {
        expect(BackgroundUploader.upload).toHaveBeenCalledWith(
          expect.objectContaining({ headers }),
        );
        expect(FileSystem.uploadAsync).not.toHaveBeenCalled();
      }
    },
  );
});

describe('declared audio purpose', (): void => {
  const uploadedParameters = (): (Record<string, string> | undefined)[] => [
    ...jest.mocked(BackgroundUploader.upload).mock.calls.map(([options]) => options.parameters),
    ...jest
      .mocked(FileSystem.uploadAsync)
      .mock.calls.map(
        ([, , options]) =>
          (options as { parameters?: Record<string, string> } | undefined)?.parameters,
      ),
  ];

  it.each([
    { requestContext: 'keyboard', purpose: 'dictation' },
    { requestContext: 'recording', purpose: 'dictation' },
    { requestContext: 'file', purpose: 'upload' },
  ] as const)(
    'sends $purpose for $requestContext on inline, chunked and cleanup uploads',
    async ({ requestContext, purpose }): Promise<void> => {
      const request: TranscriptionRequest = {
        audioUri: 'file:///recording.wav',
        provider: 'cloud',
        requestContext,
        purpose,
      };
      await TranscriptionService.transcribe(request);
      await TranscriptionService.transcribeWithCloudCleanup(request);
      jest.mocked(FileSystem.getInfoAsync).mockResolvedValueOnce({
        exists: true,
        isDirectory: false,
        uri: 'file:///recording.wav',
        size: 8 * 1024 * 1024,
        modificationTime: 0,
      });
      await TranscriptionService.transcribe(request);

      const parameters = uploadedParameters();
      expect(parameters).toHaveLength(3);
      for (const sent of parameters) {
        expect(sent).toMatchObject({ purpose, requestContext });
      }
    },
  );
});

describe('chunked transcription timing', (): void => {
  it('returns one timed segment per chunk and skips empty chunks', async (): Promise<void> => {
    jest.mocked(FileSystem.getInfoAsync).mockResolvedValueOnce({
      exists: true,
      isDirectory: false,
      uri: 'file:///recording.wav',
      size: 8 * 1024 * 1024,
      modificationTime: 0,
    });
    jest.mocked(AudioTools.splitToChunks).mockResolvedValue({
      chunks: ['file:///c0.wav', 'file:///c1.wav', 'file:///c2.wav'],
      durationMs: 360_000,
    });
    const textByChunk: Record<string, string> = {
      'file:///c0.wav': 'First part.',
      'file:///c1.wav': '',
      'file:///c2.wav': 'Last part.',
    };
    jest.mocked(FileSystem.uploadAsync).mockImplementation(
      async (_url, fileUri) =>
        ({
          status: 200,
          body: JSON.stringify({ text: textByChunk[fileUri] }),
          headers: {},
          mimeType: null,
        }) as Awaited<ReturnType<typeof FileSystem.uploadAsync>>,
    );

    const result = await TranscriptionService.transcribe({
      audioUri: 'file:///recording.wav',
      provider: 'cloud',
      requestContext: 'keyboard',
    });

    expect(result.text).toBe('First part. Last part.');
    expect(result.segments).toEqual([
      { text: 'First part.', t0: 0, t1: 12_000 },
      { text: 'Last part.', t0: 24_000, t1: 36_000 },
    ]);
  });

  it.each([
    { status: 422, body: { error: 'No speech detected in audio', code: 'NO_SPEECH_DETECTED' } },
    { status: 400, body: { error: 'Bad audio' } },
  ])(
    'treats a silent chunk as empty text and fails on any other chunk error ($status)',
    async ({ status, body }): Promise<void> => {
      jest.mocked(FileSystem.getInfoAsync).mockResolvedValueOnce({
        exists: true,
        isDirectory: false,
        uri: 'file:///recording.wav',
        size: 8 * 1024 * 1024,
        modificationTime: 0,
      });
      jest.mocked(AudioTools.splitToChunks).mockResolvedValue({
        chunks: ['file:///c0.wav', 'file:///c1.wav', 'file:///c2.wav'],
        durationMs: 360_000,
      });
      jest.mocked(FileSystem.uploadAsync).mockImplementation(
        async (_url, fileUri) =>
          (fileUri === 'file:///c1.wav'
            ? { status, body: JSON.stringify(body), headers: {}, mimeType: null }
            : {
                status: 200,
                body: JSON.stringify({ text: fileUri === 'file:///c0.wav' ? 'First.' : 'Last.' }),
                headers: {},
                mimeType: null,
              }) as Awaited<ReturnType<typeof FileSystem.uploadAsync>>,
      );

      const transcription = TranscriptionService.transcribe({
        audioUri: 'file:///recording.wav',
        provider: 'cloud',
        requestContext: 'keyboard',
      });

      if (status !== 422) {
        await expect(transcription).rejects.toThrow();
        return;
      }
      const result = await transcription;
      expect(result.text).toBe('First. Last.');
      expect(result.segments).toEqual([
        { text: 'First.', t0: 0, t1: 12_000 },
        { text: 'Last.', t0: 24_000, t1: 36_000 },
      ]);
    },
  );

  it('returns no segments for ogg chunks, which are cut by size', async (): Promise<void> => {
    jest.mocked(FileSystem.getInfoAsync).mockResolvedValueOnce({
      exists: true,
      isDirectory: false,
      uri: 'file:///recording.ogg',
      size: 8 * 1024 * 1024,
      modificationTime: 0,
    });
    jest.mocked(AudioTools.splitOggOpus).mockResolvedValue({
      chunks: ['file:///o0.ogg', 'file:///o1.ogg'],
      durationMs: 0,
    });
    const textByChunk: Record<string, string> = {
      'file:///o0.ogg': 'One.',
      'file:///o1.ogg': 'Two.',
    };
    jest.mocked(FileSystem.uploadAsync).mockImplementation(
      async (_url, fileUri) =>
        ({
          status: 200,
          body: JSON.stringify({ text: textByChunk[fileUri] }),
          headers: {},
          mimeType: null,
        }) as Awaited<ReturnType<typeof FileSystem.uploadAsync>>,
    );

    const result = await TranscriptionService.transcribe({
      audioUri: 'file:///recording.ogg',
      provider: 'cloud',
      requestContext: 'keyboard',
    });

    expect(result.text).toBe('One. Two.');
    expect(result.segments).toBeUndefined();
  });
});

jest.mock('../insights', () => ({
  insightsScope: () => 'device',
  recordInsight: jest.fn(),
  countSpokenWords: (text: string) => text.trim().split(/\s+/).length,
}));
import { processAndroidAudio, type DictationMode } from '../pipeline';
import { transcribeAndCleanup } from '@/lib/transcribeAndCleanup';
import { cleanupTranscript } from '@/lib/cleanupTranscript';
import type { TranscriptionJobRoute } from '@/lib/inferenceRouting';
import { TranscriptionService } from '@/services/transcription/TranscriptionService';
import { ReasoningService } from '@/services/reasoning/ReasoningService';
import type { TranscriptionProvider } from '@/types';

jest.mock('expo-router', () => ({ router: { push: jest.fn() } }));
jest.mock('@/lib/inferenceRouting', () => ({ snapshotTextInference: () => ({}) }));
jest.mock('@/lib/transcriptionLanguage', () => ({
  getPreferredTranscriptionLanguage: () => undefined,
  getPreferredTranscriptionLanguages: () => [],
}));
jest.mock('@/services/transcription/TranscriptionService', () => ({
  TranscriptionService: {
    transcribe: jest.fn(async ({ provider }: { provider: TranscriptionProvider }) => ({
      text: 'original words',
      provider,
      duration: 3,
    })),
    transcribeWithCloudCleanup: jest.fn(async () => ({
      text: 'Discarded cleanup.',
      originalText: 'original words',
      provider: 'cloud',
      duration: 3,
      cleanupApplied: true,
      fusedCleanup: true,
    })),
    canAttemptFusedCloudCleanup: () => true,
    requestNeedsChunking: async () => false,
    isFusedCleanupUnavailableError: () => false,
  },
  isLocalModelMissingError: () => false,
}));
jest.mock('@/lib/cleanupTranscript', () => ({
  cleanupTranscript: jest.fn(async () => 'Discarded cleanup.'),
}));
jest.mock('@/services/reasoning/ReasoningService', () => ({
  ReasoningService: {
    processText: jest.fn(async () => ({ text: 'Requested action result.', model: 'test' })),
  },
}));
jest.mock('@/services/transcription/LocalTranscriptionService', () => ({
  LocalTranscriptionService: { cancelTranscription: jest.fn() },
}));
jest.mock('@/lib/permissions', () => ({ isNoSpeechError: () => false }));
jest.mock('@/android/models', () => ({ modelReady: async () => true }));
jest.mock('@/android/LocalTextModel', () => ({ selectedTextModel: () => 'qwen-balanced' }));
jest.mock('@/store/useAuthStore', () => ({
  useAuthStore: { getState: () => ({ user: { id: 'test', isAnonymous: false } }) },
}));
jest.mock('@/store/useConfigStore', () => ({
  useConfigStore: {
    getState: () => ({
      config: {
        androidHistoryDays: 0,
        cleanupEnabled: true,
        inference: { cleanup: { mode: 'local' } },
      },
    }),
  },
}));
jest.mock('@/store/useProcessingModeStore', () => ({
  useProcessingModeStore: { getState: () => ({ activeMode: 'private' }) },
}));
jest.mock('@/store/useSnippetsStore', () => ({
  useSnippetsStore: {
    getState: () => ({
      isLoaded: true,
      entries: [{ trigger: 'original words', replacement: 'Snippet expansion.' }],
    }),
  },
}));
jest.mock('@/store/useDictionaryStore', () => ({
  useDictionaryStore: { getState: () => ({ isLoaded: true, entries: [] }) },
}));
jest.mock('@/store/useCustomPromptsStore', () => ({
  getActiveCustomCleanupPrompt: () => undefined,
}));
jest.mock('@/store/useTranscriptStore', () => ({ useTranscriptStore: { getState: jest.fn() } }));

const routes: Record<TranscriptionProvider, TranscriptionJobRoute> = {
  local: { provider: 'local', cleanupRoute: { mode: 'local', scope: 'cleanup' } },
  cloud: { provider: 'cloud', cleanupRoute: { mode: 'openwhispr', scope: 'cleanup' } },
  byok: {
    provider: 'byok',
    inferenceRoute: {
      mode: 'providers',
      scope: 'dictation',
      providerId: 'openai',
      modelId: 'gpt-4o-transcribe',
      endpoint: 'https://api.openai.com/v1',
      credentialRef: 'provider.openai',
    },
    cleanupRoute: {
      mode: 'providers',
      scope: 'cleanup',
      providerId: 'openai',
      modelId: 'gpt-5-mini',
      endpoint: 'https://api.openai.com/v1',
      credentialRef: 'provider.openai',
    },
  },
};
const audio = { uri: 'file:///cache/fixture.wav', durationMs: 3000, noSpeech: false };
beforeEach(() => jest.clearAllMocks());

describe.each(['local', 'cloud', 'byok'] as const)('%s speech for Android actions', (provider) => {
  it.each(['translate', 'write', 'edit'] as const)(
    'performs only the requested %s action without an unused cleanup pass',
    async (mode: DictationMode) => {
      const route = routes[provider];
      const signal = new AbortController().signal;
      const result = await processAndroidAudio(
        audio,
        {
          route,
          mode,
          target: 'Spanish',
          selection: 'Apples and milk.',
          eventId: 'test-event',
          accountScope: 'device',
          startedAt: '2026-10-15T10:00:00Z',
          localDate: '2026-10-15',
        },
        signal,
        jest.fn(),
      );

      expect(TranscriptionService.transcribeWithCloudCleanup).not.toHaveBeenCalled();
      expect(cleanupTranscript).not.toHaveBeenCalled();
      expect(TranscriptionService.transcribe).toHaveBeenCalledTimes(1);
      expect(TranscriptionService.transcribe).toHaveBeenCalledWith(expect.objectContaining(route));
      expect(ReasoningService.processText).toHaveBeenCalledTimes(1);
      expect(ReasoningService.processText).toHaveBeenCalledWith(
        expect.objectContaining({
          text:
            mode === 'edit'
              ? 'Original text:\nApples and milk.\n\nEditing instruction:\noriginal words'
              : 'original words',
          inferenceRoute: route.cleanupRoute,
          signal,
        }),
      );
      expect(result).toBe('Requested action result.');
    },
  );
});

it('keeps ordinary dictation cleanup enabled by default', async () => {
  const result = await transcribeAndCleanup({
    ...routes.local,
    audioUri: audio.uri,
    requestContext: 'keyboard',
  });
  expect(cleanupTranscript).toHaveBeenCalledTimes(1);
  expect(result.text).toBe('Discarded cleanup.');
});

it('returns raw action input without expanding snippets or reporting cleanup stages', async () => {
  const onStage = jest.fn();
  const onCleanupDone = jest.fn();
  const result = await transcribeAndCleanup(
    { ...routes.local, audioUri: audio.uri, requestContext: 'keyboard' },
    { transcriptionOnly: true, onStage, onCleanupDone },
  );
  expect(result.text).toBe('original words');
  expect(result.originalText).toBe('original words');
  expect(result.cleanupApplied).toBe(false);
  expect(onStage.mock.calls).toEqual([['transcribing', { fusedCleanup: false }]]);
  expect(onCleanupDone).not.toHaveBeenCalled();
});

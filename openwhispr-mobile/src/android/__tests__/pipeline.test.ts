jest.mock('../insights', () => ({
  insightsScope: () => 'device',
  recordInsight: jest.fn(),
  countSpokenWords: (text: string) => text.trim().split(/\s+/).length,
}));
jest.mock('@/lib/transcribeAndCleanup', () => ({ transcribeAndCleanup: jest.fn() }));
jest.mock('@/lib/inferenceRouting', () => ({
  snapshotTranscriptionJob: jest.fn(() => ({
    provider: 'local',
    cleanupRoute: { mode: 'local', scope: 'cleanup' },
  })),
}));
jest.mock('@/lib/transcriptionLanguage', () => ({
  getPreferredTranscriptionLanguage: () => undefined,
  getPreferredTranscriptionLanguages: () => [],
}));
jest.mock('@/services/reasoning/ReasoningService', () => ({
  ReasoningService: { processText: jest.fn() },
}));
jest.mock('@/services/transcription/LocalTranscriptionService', () => ({
  LocalTranscriptionService: { cancelTranscription: jest.fn(async () => undefined) },
}));
jest.mock('@/android/models', () => ({ modelReady: jest.fn(async () => true) }));
jest.mock('@/android/LocalTextModel', () => ({ selectedTextModel: () => 'qwen-small' }));
jest.mock('@/store/useConfigStore', () => ({ useConfigStore: { getState: jest.fn() } }));
jest.mock('@/store/useTranscriptStore', () => ({ useTranscriptStore: { getState: jest.fn() } }));

import {
  createAndroidJob,
  processAndroidAudio,
  applyHistoryRetention,
  ensureAndroidModels,
} from '../pipeline';
import { transcribeAndCleanup } from '@/lib/transcribeAndCleanup';
import { ReasoningService } from '@/services/reasoning/ReasoningService';
import { useConfigStore } from '@/store/useConfigStore';
import { useTranscriptStore } from '@/store/useTranscriptStore';
import { modelReady } from '../models';
import type { UserConfig } from '@/types';

const config: Partial<UserConfig> = { androidHistoryDays: -1 };
const history = {
  transcripts: [] as { id: string; createdAt: number }[],
  loadTranscripts: jest.fn(),
  addTranscript: jest.fn(),
  deleteTranscript: jest.fn(),
};
const audio = { uri: 'file:///cache/fixture.wav', durationMs: 3000, noSpeech: false };
const result = {
  text: 'Cleaned words.',
  originalText: 'original words',
  transcription: { provider: 'local' },
};
beforeEach(() => {
  jest.clearAllMocks();
  config.androidHistoryDays = -1;
  delete config.androidStyleContext;
  delete config.androidStyleTones;
  delete config.keyboardTone;
  config.cleanupEnabled = true;
  config.inference = { cleanup: { mode: 'local' } };
  history.transcripts = [];
  jest.mocked(useConfigStore.getState).mockReturnValue({ config } as never);
  jest.mocked(useTranscriptStore.getState).mockReturnValue(history as never);
  jest.mocked(transcribeAndCleanup).mockResolvedValue(result as never);
  jest.mocked(modelReady).mockResolvedValue(true);
});
const run = (signal = new AbortController().signal) =>
  processAndroidAudio(audio, createAndroidJob(), signal, jest.fn());

it('refuses missing local weights before transcription rather than choosing a cloud route', async () => {
  jest.mocked(modelReady).mockResolvedValue(false);
  await expect(run()).rejects.toThrow('Download');
  expect(transcribeAndCleanup).not.toHaveBeenCalled();
  expect(ReasoningService.processText).not.toHaveBeenCalled();
});
it('does not report cleanup failure as a successful practice result', async () => {
  jest.mocked(transcribeAndCleanup).mockResolvedValue({
    ...result,
    transcription: { cleanupWarning: 'Local cleanup failed.' },
  } as never);
  await expect(run()).rejects.toThrow('Local cleanup failed.');
  await expect(run()).rejects.toMatchObject({ transcript: 'original words' });
  expect(history.addTranscript).not.toHaveBeenCalled();
});
it('discards cancellation before history and any translation call', async () => {
  const controller = new AbortController();
  jest.mocked(transcribeAndCleanup).mockImplementation(async () => {
    controller.abort();
    return result as never;
  });
  await expect(run(controller.signal)).rejects.toThrow('cancelled');
  expect(history.addTranscript).not.toHaveBeenCalled();
});
it('keeps local dictation on its saved route and does not save when history is off', async () => {
  config.androidHistoryDays = 0;
  await expect(run()).resolves.toBe('Cleaned words.');
  expect(transcribeAndCleanup).toHaveBeenCalledWith(
    expect.objectContaining({
      provider: 'local',
      language: 'auto',
      cleanupRoute: { mode: 'local', scope: 'cleanup' },
    }),
    expect.any(Object),
  );
  expect(history.addTranscript).not.toHaveBeenCalled();
});
it('passes the original selected text to local editing without replacing it with the spoken instruction', async () => {
  jest
    .mocked(ReasoningService.processText)
    .mockResolvedValue({ text: 'Apples and oat milk.', model: 'test' });
  const signal = new AbortController().signal;
  await processAndroidAudio(
    audio,
    createAndroidJob('edit', 'Spanish', 'Apples and milk.'),
    signal,
    jest.fn(),
  );
  expect(ReasoningService.processText).toHaveBeenCalledWith(
    expect.objectContaining({
      text: 'Original text:\nApples and milk.\n\nEditing instruction:\noriginal words',
      routing: { isPrivateNote: true },
      signal,
      inferenceRoute: { mode: 'local', scope: 'cleanup' },
    }),
  );
});
it('expires only history entries outside the configured retention window', async () => {
  config.androidHistoryDays = 7;
  history.transcripts = [
    { id: 'old', createdAt: Date.now() - 8 * 86400000 },
    { id: 'recent', createdAt: Date.now() - 1000 },
  ];
  await applyHistoryRetention();
  expect(history.deleteTranscript.mock.calls).toEqual([['old']]);
});

it('keeps the selected context tone when preferences change during a recording', async () => {
  config.keyboardTone = 'default';
  config.androidStyleContext = 'work';
  config.androidStyleTones = { work: 'formal', personal: 'casual' };
  const job = createAndroidJob();
  config.androidStyleContext = 'personal';
  await processAndroidAudio(audio, job, new AbortController().signal, jest.fn());
  expect(transcribeAndCleanup).toHaveBeenCalledWith(
    expect.objectContaining({ keyboardTone: 'formal' }),
    expect.any(Object),
  );
  expect(createAndroidJob().tone).toBe('casual');
});

it('allows speech-only dictation when cleanup is disabled and text weights are missing', async () => {
  config.cleanupEnabled = false;
  jest.mocked(modelReady).mockImplementation(async (id) => id === 'parakeet-v3');
  await expect(ensureAndroidModels(createAndroidJob())).resolves.toBeUndefined();
});

it('requires local text weights for translation even with cleanup switched off', async () => {
  config.cleanupEnabled = false;
  jest.mocked(modelReady).mockImplementation(async (id) => id === 'parakeet-v3');
  await expect(ensureAndroidModels(createAndroidJob('translate'))).rejects.toThrow('text model');
});

it('checks local cleanup weights even when speech uses cloud', async () => {
  jest.mocked(modelReady).mockResolvedValue(false);
  const job = createAndroidJob();
  job.route.provider = 'cloud';
  await expect(ensureAndroidModels(job)).rejects.toThrow('text model');
});

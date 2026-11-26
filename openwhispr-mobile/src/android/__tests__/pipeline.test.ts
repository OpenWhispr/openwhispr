let mockHistoryScope: { owner: string; key: string; revision: number } | null = null;
jest.mock('@/lib/transcriptScope', () => ({
  captureTranscriptScope: () => mockHistoryScope,
  isTranscriptScopeCurrent: (scope: unknown) => scope === mockHistoryScope,
  observeTranscriptScope: () => () => {},
}));
jest.mock('../insights', () => ({
  insightsScope: () => 'device',
  recordInsight: jest.fn(),
  countSpokenWords: (text: string) => text.trim().split(/\s+/).length,
}));
jest.mock('@/android/dictation/transcribeAndCleanup', () => ({ transcribeAndCleanup: jest.fn() }));
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
// Shared files reach Android's service through the shared path, as Metro's re-export does.
jest.mock('@/services/reasoning/ReasoningService', () =>
  jest.requireMock('@/android/reasoning/ReasoningService'),
);
jest.mock('@/android/reasoning/ReasoningService', () => ({
  ReasoningService: { processText: jest.fn() },
}));
jest.mock('@/android/transcription/LocalTranscriptionService', () => ({
  LocalTranscriptionService: { cancelTranscription: jest.fn(async () => undefined) },
}));
jest.mock('@/android/models', () => ({
  modelReady: jest.fn(async () => true),
  ANDROID_MODELS: {
    'parakeet-v3': { kind: 'speech', meetings: true },
    'moonshine-small': { kind: 'speech' },
    'moonshine-tiny': { kind: 'speech' },
  },
  modelSupported: () => true,
}));
jest.mock('@/android/LocalTextModel', () => ({ selectedTextModel: () => 'qwen-small' }));
jest.mock('@/store/useConfigStore', () => ({ useConfigStore: { getState: jest.fn() } }));
jest.mock('@/store/useTranscriptStore', () => ({ useTranscriptStore: { getState: jest.fn() } }));
jest.mock('@/store/useAuthStore', () => ({
  useAuthStore: { getState: () => ({ user: null }) },
}));

import {
  createAndroidJob,
  processAndroidAudio,
  applyHistoryRetention,
  ensureAndroidModels,
} from '../pipeline';
import { transcribeAndCleanup } from '@/android/dictation/transcribeAndCleanup';
import { ReasoningService } from '@/android/reasoning/ReasoningService';
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
  mockHistoryScope = null;
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
    .mockResolvedValue({ text: '{"replacement":"Apples and oat milk."}', model: 'test' });
  const signal = new AbortController().signal;
  await expect(
    processAndroidAudio(
      audio,
      createAndroidJob('edit', 'Spanish', 'Apples and milk.'),
      signal,
      jest.fn(),
    ),
  ).resolves.toBe('Apples and oat milk.');
  expect(ReasoningService.processText).toHaveBeenCalledWith(
    expect.objectContaining({
      text: 'Selected document (JSON string):\n"Apples and milk."\n\nEditing instruction:\noriginal words\n\nReturn the replacement JSON object.',
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

it('cleans in the tone picked for the kind of app the dictation started in', async () => {
  const style = config as { androidToneStyle?: unknown };
  style.androidToneStyle = {
    enabled: true,
    tones: { personal: 'very_casual', work: 'casual', email: 'excited', other: 'formal' },
  };
  const job = createAndroidJob('dictate', 'Spanish', '', 'com.Slack');
  // A pick changed while the take records doesn't change this take.
  style.androidToneStyle = { enabled: true, tones: { work: 'formal' } };
  await processAndroidAudio(audio, job, new AbortController().signal, jest.fn());
  expect(transcribeAndCleanup).toHaveBeenCalledWith(
    expect.objectContaining({ keyboardTone: 'casual', keyboardAppCategory: 'work' }),
    expect.any(Object),
  );
  style.androidToneStyle = { enabled: true, tones: {} };
  expect(createAndroidJob('dictate', 'Spanish', '', 'com.google.android.gm')).toMatchObject({
    tone: 'formal',
    appCategory: 'email',
  });
  expect(createAndroidJob('dictate', 'Spanish', '', 'org.mozilla.firefox')).toMatchObject({
    tone: 'formal',
    appCategory: 'other',
  });
  delete style.androidToneStyle;
});

it('leaves the speaker’s own tone while Tone & Style is off', () => {
  const style = config as { androidToneStyle?: unknown; keyboardTone?: string };
  style.keyboardTone = 'excited';
  style.androidToneStyle = { enabled: false, tones: { personal: 'very_casual' } };
  const job = createAndroidJob('dictate', 'Spanish', '', 'com.whatsapp');
  expect(job.tone).toBeUndefined();
  expect(job.appCategory).toBeUndefined();
  delete style.androidToneStyle;
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

it('discards a dictation that completes after the account changed and returned', async () => {
  mockHistoryScope = { owner: 'account:a', key: 'history:a', revision: 1 };
  const job = createAndroidJob();
  jest.mocked(transcribeAndCleanup).mockImplementation(async () => {
    mockHistoryScope = { owner: 'account:a', key: 'history:a', revision: 3 };
    return result as never;
  });
  await expect(
    processAndroidAudio(audio, job, new AbortController().signal, jest.fn()),
  ).rejects.toThrow('cancelled');
  expect(history.addTranscript).not.toHaveBeenCalled();
});

it('does not expire the next account history when a retention load finishes late', async () => {
  config.androidHistoryDays = 7;
  history.loadTranscripts.mockImplementationOnce(async () => {
    mockHistoryScope = { owner: 'account:b', key: 'history:b', revision: 2 };
    history.transcripts = [{ id: 'b-old', createdAt: 1 }];
  });
  await applyHistoryRetention();
  expect(history.deleteTranscript).not.toHaveBeenCalled();
});

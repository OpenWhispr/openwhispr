jest.mock('../../../modules/android-dictation/src', () => ({
  AndroidDictation: {
    transcribeParakeet: jest.fn(),
    cancelParakeet: jest.fn(),
    transcribeMoonshine: jest.fn(),
    cancelMoonshine: jest.fn(),
    releaseParakeet: jest.fn(async () => undefined),
    releaseMoonshine: jest.fn(async () => undefined),
  },
}));
jest.mock('../models', () => ({
  modelReady: jest.fn(),
  modelPath: (id: string) => `file:///models/${id}`,
}));
jest.mock('../speechSelection', () => ({ selectedSpeechModel: jest.fn(() => 'parakeet-v3') }));
jest.mock('@/lib/transcriptionLanguage', () => ({
  getPreferredTranscriptionLanguages: jest.fn(() => []),
}));
jest.mock('../LocalTextModel', () => ({
  LocalTextModel: { release: jest.fn(async () => undefined) },
}));

import { LocalSpeechModel } from '../LocalSpeechModel';
import { LocalTextModel } from '../LocalTextModel';
import { AndroidDictation } from '../../../modules/android-dictation/src';
import { modelReady } from '../models';
import { selectedSpeechModel } from '../speechSelection';
import { withAndroidInference } from '../inferenceQueue';
import { getPreferredTranscriptionLanguages } from '@/lib/transcriptionLanguage';

beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(getPreferredTranscriptionLanguages).mockReturnValue([]);
  jest.mocked(selectedSpeechModel).mockReturnValue('parakeet-v3');
  jest
    .mocked(AndroidDictation!.transcribeMoonshine)
    .mockResolvedValue({ text: 'Hello.', duration: 1, processingMs: 50 });
  jest.mocked(modelReady).mockResolvedValue(true);
  jest.mocked(AndroidDictation!.transcribeParakeet).mockResolvedValue({
    text: 'Hello.',
    duration: 1,
    processingMs: 120,
    tokenTimings: [
      { token: ' Hello', startTime: 0, endTime: 0.5 },
      { token: '.', startTime: 0.5, endTime: 0.5 },
    ],
  });
});
it('uses Parakeet with shared word timings and frees the text runtime first', async () => {
  const result = await LocalSpeechModel.transcribe('file:///sample.wav', {
    wordTimestamps: true,
    language: 'en-US',
  });
  expect(result).toMatchObject({
    endpoint: 'parakeet-v3',
    provider: 'local',
    segments: [{ text: 'Hello.', t0: 0, t1: 50 }],
  });
  expect(AndroidDictation!.transcribeParakeet).toHaveBeenCalledWith(
    'file:///sample.wav',
    'file:///models/parakeet-v3',
  );
  expect(jest.mocked(LocalTextModel.release).mock.invocationCallOrder[0]).toBeLessThan(
    jest.mocked(AndroidDictation!.transcribeParakeet).mock.invocationCallOrder[0],
  );
});

it('refuses unsupported languages instead of silently sending them elsewhere', async () => {
  await expect(
    LocalSpeechModel.transcribe('file:///sample.wav', { language: 'ja' }),
  ).rejects.toThrow('25 European');
  expect(AndroidDictation!.transcribeParakeet).not.toHaveBeenCalled();
});
it('refuses missing model weights without invoking the runtime', async () => {
  jest.mocked(modelReady).mockResolvedValue(false);
  await expect(LocalSpeechModel.transcribe('file:///sample.wav', {})).rejects.toThrow(/download/i);
  expect(AndroidDictation!.transcribeParakeet).not.toHaveBeenCalled();
});

it.each(['moonshine-tiny', 'moonshine-small'] as const)(
  'keeps ordinary %s transcription available without requesting word timings',
  async (model) => {
    jest.mocked(selectedSpeechModel).mockReturnValue(model);
    const result = await LocalSpeechModel.transcribe('file:///sample.wav', {
      language: 'en-GB',
      wordTimestamps: false,
    });
    expect(result).toMatchObject({ endpoint: model, text: 'Hello.' });
    expect(result.segments).toBeUndefined();
    expect(AndroidDictation!.transcribeMoonshine).toHaveBeenCalledWith(
      'file:///sample.wav',
      `file:///models/${model}`,
      model,
    );
    expect(AndroidDictation!.releaseParakeet).toHaveBeenCalled();
    expect(AndroidDictation!.transcribeParakeet).not.toHaveBeenCalled();
  },
);
it('rejects a non-English Moonshine request without switching engines or using the network', async () => {
  jest.mocked(selectedSpeechModel).mockReturnValue('moonshine-tiny');
  await expect(
    LocalSpeechModel.transcribe('file:///sample.wav', { language: 'fr' }),
  ).rejects.toThrow('English only');
  expect(AndroidDictation!.transcribeMoonshine).not.toHaveBeenCalled();
  expect(AndroidDictation!.transcribeParakeet).not.toHaveBeenCalled();
});
it('rejects an unsupported multilingual selection even when no single-language hint is supplied', async () => {
  jest.mocked(selectedSpeechModel).mockReturnValue('moonshine-small');
  jest.mocked(getPreferredTranscriptionLanguages).mockReturnValue(['en', 'fr']);
  await expect(
    LocalSpeechModel.transcribe('file:///sample.wav', { language: 'auto' }),
  ).rejects.toThrow('English only');
  expect(AndroidDictation!.transcribeMoonshine).not.toHaveBeenCalled();
});
it('keeps the selected model while waiting for another local job', async () => {
  let unblock!: () => void;
  const blocker = withAndroidInference(
    () =>
      new Promise<void>((resolve) => {
        unblock = resolve;
      }),
  );
  await Promise.resolve();
  jest.mocked(selectedSpeechModel).mockReturnValue('moonshine-small');
  const pending = LocalSpeechModel.transcribe('file:///sample.wav', {});
  jest.mocked(selectedSpeechModel).mockReturnValue('parakeet-v3');
  unblock();
  await blocker;
  expect((await pending).endpoint).toBe('moonshine-small');
});
it('discards Moonshine results cancelled during native inference', async () => {
  jest.mocked(selectedSpeechModel).mockReturnValue('moonshine-tiny');
  jest.mocked(AndroidDictation!.transcribeMoonshine).mockImplementation(async () => {
    LocalSpeechModel.cancel();
    return { text: 'Discard me', duration: 1, processingMs: 50 };
  });
  await expect(LocalSpeechModel.transcribe('file:///sample.wav', {})).rejects.toThrow('cancelled');
  expect(AndroidDictation!.cancelMoonshine).toHaveBeenCalled();
});
it('discards a native result when cancellation arrives during inference', async () => {
  jest.mocked(AndroidDictation!.transcribeParakeet).mockImplementation(async () => {
    LocalSpeechModel.cancel();
    return { text: 'Discard me', duration: 1, processingMs: 10, tokenTimings: [] };
  });
  await expect(LocalSpeechModel.transcribe('file:///sample.wav', {})).rejects.toThrow('cancelled');
  expect(AndroidDictation!.cancelParakeet).toHaveBeenCalled();
});

it('uses the explicitly pinned speech model without changing the saved selection', async () => {
  jest.mocked(selectedSpeechModel).mockReturnValue('parakeet-v3');
  await LocalSpeechModel.transcribe('file:///sample.wav', {
    androidModel: 'moonshine-tiny',
    language: 'en',
  });
  expect(AndroidDictation!.transcribeMoonshine).toHaveBeenCalled();
  expect(AndroidDictation!.transcribeParakeet).not.toHaveBeenCalled();
});
it('does not cancel another job when an aborted sample is waiting in the inference queue', async () => {
  let release!: () => void;
  const occupied = withAndroidInference(
    () =>
      new Promise<void>((done) => {
        release = done;
      }),
  );
  await Promise.resolve();
  const controller = new AbortController();
  const waiting = LocalSpeechModel.transcribe('file:///sample.wav', { signal: controller.signal });
  controller.abort();
  expect(AndroidDictation!.cancelParakeet).not.toHaveBeenCalled();
  release();
  await occupied;
  await expect(waiting).rejects.toThrow();
  expect(AndroidDictation!.transcribeParakeet).not.toHaveBeenCalled();
});

it.each(['moonshine-tiny', 'moonshine-small'] as const)(
  'rejects required word timing for %s before loading a model',
  async (model) => {
    jest.mocked(selectedSpeechModel).mockReturnValue(model);
    await expect(
      LocalSpeechModel.transcribe('file:///meeting.wav', { wordTimestamps: true }),
    ).rejects.toThrow(/Parakeet/);
    expect(AndroidDictation!.transcribeMoonshine).not.toHaveBeenCalled();
    expect(AndroidDictation!.transcribeParakeet).not.toHaveBeenCalled();
    expect(LocalTextModel.release).not.toHaveBeenCalled();
  },
);

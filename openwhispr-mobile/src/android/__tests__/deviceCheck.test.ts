jest.mock('../../../modules/android-dictation/src', () => ({
  AndroidDictation: {
    getDeviceProfile: jest.fn(),
    prepareSampleDecode: jest.fn(() => 'sample-1'),
    cancelSampleDecode: jest.fn(),
    decodeSampleAudio: jest.fn(),
  },
}));
jest.mock('expo-file-system/legacy', () => ({
  cacheDirectory: 'file:///cache/',
  deleteAsync: jest.fn(async () => {}),
}));
jest.mock('../LocalSpeechModel', () => ({ LocalSpeechModel: { transcribe: jest.fn() } }));
jest.mock('../LocalTextModel', () => ({
  LocalTextModel: { processText: jest.fn() },
  selectedTextModel: () => 'qwen-balanced',
}));
jest.mock('../models', () => ({ modelReady: jest.fn(async () => true) }));
jest.mock('@/lib/dictationHints', () => ({ buildDictationHints: () => [] }));
jest.mock('@/store/useCustomPromptsStore', () => ({
  getActiveCustomCleanupPrompt: () => undefined,
}));
jest.mock('@/store/useConfigStore', () => ({
  useConfigStore: { getState: () => ({ config: {} }) },
}));
jest.mock('@/lib/transcriptionLanguage', () => ({
  getPreferredTranscriptionLanguages: () => ['en'],
}));
import * as FileSystem from 'expo-file-system/legacy';
import { AndroidDictation, type DeviceProfile } from '../../../modules/android-dictation/src';
import { LocalSpeechModel } from '../LocalSpeechModel';
import { LocalTextModel } from '../LocalTextModel';
import { modelReady } from '../models';
import {
  runLocalBenchmark,
  deviceGuidance,
  type BenchmarkSelection,
  type LocalBenchmark,
} from '../deviceCheck';
const selection: BenchmarkSelection = {
  speech: 'moonshine-tiny',
  text: 'qwen-small',
  languages: ['en'],
  language: 'en',
  customDictionary: ['OpenWhispr'],
  tone: 'formal',
};
const profile = {
  emulator: false,
  lowMemory: false,
  lowRamDevice: false,
  thermalStatus: 0,
} as DeviceProfile;
beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(AndroidDictation!.getDeviceProfile).mockReturnValue(profile);
  jest
    .mocked(AndroidDictation!.decodeSampleAudio)
    .mockResolvedValue({ uri: 'file:///cache/decoded.wav', durationMs: 5000, noSpeech: false });
  jest
    .mocked(LocalSpeechModel.transcribe)
    .mockResolvedValue({ text: 'hello openwhispr', duration: 5 } as never);
  jest
    .mocked(LocalTextModel.processText)
    .mockResolvedValue({ text: 'Hello OpenWhispr.', model: 'qwen-small' });
  jest.mocked(modelReady).mockResolvedValue(true);
});
it('runs the pinned pair with the actual cleanup prompt and removes only its decoded copy', async () => {
  const controller = new AbortController();
  const stages = jest.fn();
  const result = await runLocalBenchmark(
    'file:///cache/picked.wav',
    selection,
    controller.signal,
    stages,
  );
  expect(LocalSpeechModel.transcribe).toHaveBeenCalledWith('file:///cache/decoded.wav', {
    androidModel: 'moonshine-tiny',
    language: 'en',
    signal: controller.signal,
  });
  expect(LocalTextModel.processText).toHaveBeenCalledWith(
    expect.objectContaining({
      text: expect.stringContaining('hello openwhispr'),
      systemPrompt: expect.stringContaining('OpenWhispr'),
      signal: controller.signal,
      tone: 'formal',
    }),
    'qwen-small',
  );
  expect(result).toMatchObject({
    selection,
    durationMs: 5000,
    transcript: 'hello openwhispr',
    cleanedText: 'Hello OpenWhispr.',
  });
  expect(stages.mock.calls.flat()).toEqual(['preparingSample', 'processing', 'cleanup']);
  expect(FileSystem.deleteAsync).toHaveBeenCalledTimes(1);
  expect(FileSystem.deleteAsync).toHaveBeenCalledWith('file:///cache/decoded.wav', {
    idempotent: true,
  });
});
it('cleans the decoded copy after cancellation during decoding without starting speech', async () => {
  const controller = new AbortController();
  jest.mocked(AndroidDictation!.decodeSampleAudio).mockImplementationOnce(async () => {
    controller.abort();
    return { uri: 'file:///cache/decoded.wav', durationMs: 5000, noSpeech: false };
  });
  await expect(
    runLocalBenchmark('file:///original.wav', selection, controller.signal, jest.fn()),
  ).rejects.toMatchObject({ name: 'AbortError' });
  expect(LocalSpeechModel.transcribe).not.toHaveBeenCalled();
  expect(FileSystem.deleteAsync).toHaveBeenCalledWith('file:///cache/decoded.wav', {
    idempotent: true,
  });
});
it('does not start cleanup or return text after speech is cancelled', async () => {
  const controller = new AbortController();
  jest.mocked(LocalSpeechModel.transcribe).mockImplementationOnce(async () => {
    controller.abort();
    return { text: 'Late private text' } as never;
  });
  await expect(
    runLocalBenchmark('file:///cache/input.wav', selection, controller.signal, jest.fn()),
  ).rejects.toMatchObject({ name: 'AbortError' });
  expect(LocalTextModel.processText).not.toHaveBeenCalled();
  expect(FileSystem.deleteAsync).toHaveBeenCalledTimes(1);
});
it('rejects unsupported languages and missing downloads before decoding', async () => {
  await expect(
    runLocalBenchmark(
      'file:///cache/input.wav',
      { ...selection, languages: ['fr'] },
      new AbortController().signal,
      jest.fn(),
    ),
  ).rejects.toThrow(/English/);
  jest.mocked(modelReady).mockResolvedValue(false);
  await expect(
    runLocalBenchmark(
      'file:///cache/input.wav',
      selection,
      new AbortController().signal,
      jest.fn(),
    ),
  ).rejects.toThrow(/Download/);
  expect(AndroidDictation!.decodeSampleAudio).not.toHaveBeenCalled();
});
it.each([
  { ...profile, lowMemory: true },
  { ...profile, thermalStatus: 3 },
])('does not allocate inference runtimes under reported pressure', async (pressure) => {
  jest.mocked(AndroidDictation!.getDeviceProfile).mockReturnValue(pressure);
  await expect(
    runLocalBenchmark(
      'file:///cache/input.wav',
      selection,
      new AbortController().signal,
      jest.fn(),
    ),
  ).rejects.toThrow();
  expect(LocalSpeechModel.transcribe).not.toHaveBeenCalled();
});
it('rejects long samples and removes their decoded cache files', async () => {
  jest
    .mocked(AndroidDictation!.decodeSampleAudio)
    .mockResolvedValue({ uri: 'file:///cache/decoded.wav', durationMs: 30001, noSpeech: false });
  await expect(
    runLocalBenchmark(
      'file:///cache/input.wav',
      selection,
      new AbortController().signal,
      jest.fn(),
    ),
  ).rejects.toThrow(/30 seconds/);
  expect(LocalSpeechModel.transcribe).not.toHaveBeenCalled();
  expect(FileSystem.deleteAsync).toHaveBeenCalledTimes(1);
});
it('never treats emulator measurements or RAM alone as physical-device acceptance', () => {
  const result = { totalMs: 10, durationMs: 1000, after: profile } as LocalBenchmark;
  expect(deviceGuidance({ ...profile, emulator: true }, result)).toBe('deviceEmulator');
  expect(deviceGuidance(profile)).toBe('deviceTestFirst');
  expect(deviceGuidance({ ...profile, lowRamDevice: true })).toBe('deviceLowRam');
  expect(deviceGuidance(profile, { ...result, totalMs: 1100 })).toBe('deviceSlow');
  expect(deviceGuidance(profile, result)).toBe('deviceReviewAccuracy');
});
it('signals only the owned native decoder immediately on cancellation', async () => {
  const controller = new AbortController();
  let reject!: (error: Error) => void;
  jest.mocked(AndroidDictation!.decodeSampleAudio).mockImplementationOnce(
    () =>
      new Promise((_resolve, fail) => {
        reject = fail;
      }),
  );
  const pending = runLocalBenchmark(
    'file:///cache/sample.wav',
    selection,
    controller.signal,
    jest.fn(),
  );
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  controller.abort();
  expect(AndroidDictation!.cancelSampleDecode).toHaveBeenCalledWith('sample-1');
  reject(new Error('Sample cancelled.'));
  await expect(pending).rejects.toThrow('Sample cancelled.');
  expect(LocalSpeechModel.transcribe).not.toHaveBeenCalled();
});

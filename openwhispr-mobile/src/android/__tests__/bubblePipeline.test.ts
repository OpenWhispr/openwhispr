import * as FileSystem from 'expo-file-system/legacy';
import { AndroidDictation, dictationEvents } from '../../../modules/android-dictation/src';
import { processAndroidAudio, createAndroidJob, AndroidCleanupError } from '../pipeline';
import { useBubbleResult } from '../bubbleResult';
import { bootAppData } from '../appData';
import { useAccountData } from '../accountData';
import { runHeadlessStartup } from '../headlessStartup';
import { bubblePipelineTask, startBubblePipeline } from '../bubblePipeline';

type Listener = (event?: any) => unknown;
const mockListeners: Record<string, Listener> = {};
jest.mock('../../../modules/android-dictation/src', () => ({
  AndroidDictation: {
    setStatus: jest.fn(async () => {}),
    insert: jest.fn(async () => true),
    pipelineReady: jest.fn(async () => {}),
    setMenuContext: jest.fn(),
    copyText: jest.fn(),
    getStatus: jest.fn(() => ({ accessibility: true })),
  },
  dictationEvents: {
    addListener: jest.fn((event: string, listener: Listener) => {
      mockListeners[event] = listener;
      return { remove: jest.fn() };
    }),
  },
}));
jest.mock('expo-file-system/legacy', () => ({ deleteAsync: jest.fn(async () => {}) }));
jest.mock('../appData', () => ({ bootAppData: jest.fn(async () => {}) }));
jest.mock('../accountData', () => ({
  useAccountData: { getState: jest.fn(() => ({ owner: 'user-1', error: null, blocked: false })) },
}));
jest.mock('../headlessStartup', () => ({ runHeadlessStartup: jest.fn() }));
let mockRoute: Record<string, unknown> = { cleanupRoute: { mode: 'openwhispr' } };
jest.mock('@/lib/inferenceRouting', () => ({ snapshotTranscriptionJob: () => mockRoute }));
let mockGuest = false;
jest.mock('@/lib/accountAccess', () => ({ requiresRealAccount: () => mockGuest }));
const mockAuthListeners: (() => void)[] = [];
jest.mock('@/store/useAuthStore', () => ({
  useAuthStore: {
    getState: () => ({ user: null }),
    subscribe: (listener: () => void) => mockAuthListeners.push(listener),
  },
}));
let mockScopeChange: () => void = () => {};
jest.mock('@/lib/transcriptScope', () => ({
  observeTranscriptScope: (change: () => void) => {
    mockScopeChange = change;
    return () => {};
  },
}));
jest.mock('@/store/useConfigStore', () => ({
  useConfigStore: { getState: () => ({ config: {} }), subscribe: jest.fn() },
}));
jest.mock('../strings', () => ({ __esModule: true, default: { t: (key: string) => key } }));
jest.mock('../practiceSession', () => ({
  usePracticeSession: { getState: () => ({ complete: jest.fn() }) },
}));
jest.mock('../pipeline', () => {
  class CleanupError extends Error {
    transcript: string;
    constructor(message: string, text: string) {
      super(message);
      this.transcript = text;
    }
  }
  return {
    AndroidCleanupError: CleanupError,
    createAndroidJob: jest.fn((mode: string) => ({ mode })),
    processAndroidAudio: jest.fn(),
  };
});

const audio = { uri: 'file:///cache/dictation-1.wav', durationMs: 2000, noSpeech: false };
const flush = () => new Promise((resolve) => setImmediate(resolve));
const native = AndroidDictation as unknown as {
  setStatus: jest.Mock;
  insert: jest.Mock;
  pipelineReady: jest.Mock;
  setMenuContext: jest.Mock;
  copyText: jest.Mock;
  getStatus: jest.Mock;
};
const addListener = dictationEvents!.addListener as unknown as jest.Mock;

// Like the app, the tests start the pipeline once for the whole runtime.
beforeAll(() => {
  startBubblePipeline();
  expect(native.pipelineReady).toHaveBeenCalledTimes(1);
  expect(native.setMenuContext).toHaveBeenCalledWith({
    translateTarget: 'Spanish',
    assistantBlock: '',
  });
});
beforeEach(() => {
  jest.clearAllMocks();
  useBubbleResult.getState().dismiss();
});

it('a tap dictates, even over highlighted text', async () => {
  jest.mocked(processAndroidAudio).mockResolvedValue('Tomorrow at 4 works.');
  mockListeners.onStart({ selection: 'old words', mode: 'dictate' });
  await flush();
  expect(createAndroidJob).toHaveBeenCalledWith('dictate', 'Spanish', 'old words');
  mockListeners.onRecording(audio);
  await flush();
  expect(native.insert).toHaveBeenCalledWith('Tomorrow at 4 works.', { highlight: false });
  expect(native.setStatus).toHaveBeenLastCalledWith('success', {
    mode: 'dictate',
    language: undefined,
  });
  expect(FileSystem.deleteAsync).toHaveBeenCalledWith(audio.uri, { idempotent: true });
});

it.each([
  ['write', '', 'write'],
  ['translate', '', 'translate'],
  ['edit', 'old words', 'edit'],
  // Edit selection needs a selection; without one the request is written fresh.
  ['edit', '', 'write'],
  [undefined, '', 'dictate'],
  ['unknown', '', 'dictate'],
])('the menu mode %s (selection "%s") runs as %s', async (mode, selection, expected) => {
  jest
    .mocked(createAndroidJob)
    .mockImplementationOnce((value: string, target: string) => ({ mode: value, target }) as never);
  jest.mocked(processAndroidAudio).mockResolvedValueOnce('Done.');
  mockListeners.onStart({ selection, mode });
  mockListeners.onRecording(audio);
  await flush();
  expect(createAndroidJob).toHaveBeenCalledWith(expected, 'Spanish', selection);
  // Only an edit keeps its new words highlighted; the result names its mode for the Undo toast.
  expect(native.insert).toHaveBeenCalledWith('Done.', { highlight: expected === 'edit' });
  expect(native.setStatus).toHaveBeenLastCalledWith('success', {
    mode: expected,
    language: 'Spanish',
  });
});

it('a retried take runs in the mode it was recorded in', async () => {
  jest.mocked(processAndroidAudio).mockRejectedValueOnce(new Error('Network request failed'));
  mockListeners.onStart({ selection: '', mode: 'translate' });
  mockListeners.onRecording(audio);
  await flush();
  expect(native.setStatus).toHaveBeenLastCalledWith('retry-kept', { message: 'offline' });
  jest.mocked(processAndroidAudio).mockResolvedValueOnce('Hola.');
  mockListeners.onRetry({ selection: '' });
  await flush();
  expect(createAndroidJob).toHaveBeenLastCalledWith('translate', 'Spanish', '');
});

it('with typing access off, the words go on the clipboard and the tab offers to turn it on', async () => {
  jest.mocked(processAndroidAudio).mockResolvedValueOnce('Copied words');
  native.insert.mockResolvedValueOnce(false);
  native.getStatus.mockReturnValueOnce({ accessibility: false });
  mockListeners.onStart({ selection: '' });
  mockListeners.onRecording(audio);
  await flush();
  expect(native.copyText).toHaveBeenCalledWith('Copied words');
  expect(native.setStatus).toHaveBeenLastCalledWith('copied');
  expect(useBubbleResult.getState().text).toBe('Copied words');
});

it('greys the Assistant for a guest, or when its route is unavailable', () => {
  mockGuest = true;
  mockAuthListeners.forEach((listener) => listener());
  expect(native.setMenuContext).toHaveBeenLastCalledWith({
    translateTarget: 'Spanish',
    assistantBlock: 'sign-in',
  });
  mockRoute = { cleanupUnavailable: 'Choose a cleanup provider' };
  mockAuthListeners.forEach((listener) => listener());
  expect(native.setMenuContext).toHaveBeenLastCalledWith({
    translateTarget: 'Spanish',
    assistantBlock: 'unavailable',
  });
  // Nothing changed: the bubble isn't told again.
  native.setMenuContext.mockClear();
  mockAuthListeners.forEach((listener) => listener());
  expect(native.setMenuContext).not.toHaveBeenCalled();
  mockGuest = false;
  mockRoute = { cleanupRoute: { mode: 'openwhispr' } };
  mockAuthListeners.forEach((listener) => listener());
});

it('keeps a failed recording so Retry sends the same audio again, then deletes it', async () => {
  jest.mocked(processAndroidAudio).mockRejectedValueOnce(new Error('Network down'));
  mockListeners.onStart({ selection: '' });
  mockListeners.onRecording(audio);
  await flush();
  expect(native.setStatus).toHaveBeenLastCalledWith('retry-kept', { message: 'failed' });
  expect(FileSystem.deleteAsync).not.toHaveBeenCalled();
  expect(useBubbleResult.getState().error).toBe('Network down');

  jest.mocked(processAndroidAudio).mockResolvedValueOnce('Hello there.');
  mockListeners.onRetry({ selection: '' });
  await flush();
  expect(jest.mocked(processAndroidAudio).mock.calls[1][0]).toBe(audio);
  expect(native.insert).toHaveBeenCalledWith('Hello there.', { highlight: false });
  expect(native.setStatus).toHaveBeenLastCalledWith('success', {
    mode: 'dictate',
    language: undefined,
  });
  expect(FileSystem.deleteAsync).toHaveBeenCalledWith(audio.uri, { idempotent: true });
});

it('deletes a kept recording when the error is dismissed', async () => {
  jest.mocked(processAndroidAudio).mockRejectedValueOnce(new Error('Network down'));
  mockListeners.onStart({ selection: '' });
  mockListeners.onRecording(audio);
  await flush();
  mockListeners.onDismiss();
  expect(FileSystem.deleteAsync).toHaveBeenCalledWith(audio.uri, { idempotent: true });
  mockListeners.onRetry({ selection: '' });
  expect(native.setStatus).toHaveBeenLastCalledWith('retry', { message: 'failed' });
});

it('asks for a new recording after silence instead of keeping it', async () => {
  jest.mocked(processAndroidAudio).mockRejectedValueOnce(new Error('noSpeech'));
  mockListeners.onStart({ selection: '' });
  mockListeners.onRecording({ ...audio, noSpeech: true });
  await flush();
  expect(native.setStatus).toHaveBeenLastCalledWith('retry', { message: 'no-speech' });
  expect(FileSystem.deleteAsync).toHaveBeenCalled();
});

it('offers the saved text when insertion fails or cleanup needs recovery', async () => {
  jest.mocked(processAndroidAudio).mockResolvedValueOnce('Kept words');
  native.insert.mockResolvedValueOnce(false);
  mockListeners.onStart({ selection: '' });
  mockListeners.onRecording(audio);
  await flush();
  expect(native.setStatus).toHaveBeenLastCalledWith('recover');
  expect(useBubbleResult.getState()).toMatchObject({
    text: 'Kept words',
    error: 'insertionFailed',
  });

  jest
    .mocked(processAndroidAudio)
    .mockRejectedValueOnce(new AndroidCleanupError('cleanup failed', 'raw words'));
  mockListeners.onStart({ selection: '' });
  mockListeners.onRecording(audio);
  await flush();
  expect(native.setStatus).toHaveBeenLastCalledWith('recover');
  expect(useBubbleResult.getState()).toMatchObject({ text: 'raw words', error: 'cleanupRecovery' });
});

it('starts once per runtime', () => {
  startBubblePipeline();
  expect(addListener).not.toHaveBeenCalled();
  expect(native.pipelineReady).not.toHaveBeenCalled();
});

it('waits for app data before creating the job', async () => {
  let loaded!: () => void;
  jest.mocked(bootAppData).mockReturnValueOnce(new Promise<void>((resolve) => (loaded = resolve)));
  jest.mocked(processAndroidAudio).mockResolvedValueOnce('Hi.');
  mockListeners.onStart({ selection: '' });
  mockListeners.onRecording(audio);
  await flush();
  expect(createAndroidJob).not.toHaveBeenCalled();
  loaded();
  await flush();
  expect(createAndroidJob).toHaveBeenCalledWith('dictate', 'Spanish', '');
  expect(native.insert).toHaveBeenCalledWith('Hi.', { highlight: false });
});

it('a blocked account keeps the recording for Retry', async () => {
  const error = 'Local account data could not be loaded. Please retry.';
  jest.mocked(useAccountData.getState).mockReturnValueOnce({ error, blocked: true } as never);
  mockListeners.onStart({ selection: '' });
  mockListeners.onRecording(audio);
  await flush();
  expect(processAndroidAudio).not.toHaveBeenCalled();
  expect(native.setStatus).toHaveBeenLastCalledWith('retry-kept', { message: 'failed' });
  expect(useBubbleResult.getState().error).toBe(error);
  expect(FileSystem.deleteAsync).not.toHaveBeenCalled();
});

it('a failed boot keeps the recording for Retry', async () => {
  jest.mocked(bootAppData).mockRejectedValueOnce(new Error('offline'));
  mockListeners.onStart({ selection: '' });
  mockListeners.onRecording(audio);
  await flush();
  expect(native.setStatus).toHaveBeenLastCalledWith('retry-kept', { message: 'offline' });
  expect(useBubbleResult.getState().error).toBe('offline');
});

it('the headless task runs startup, reuses the pipeline and never settles', async () => {
  const settled = jest.fn();
  void bubblePipelineTask().then(settled);
  await flush();
  expect(runHeadlessStartup).toHaveBeenCalledTimes(1);
  expect(addListener).not.toHaveBeenCalled();
  expect(settled).not.toHaveBeenCalled();
});

it('leaves opening a kept result to the app', () => {
  expect(mockListeners.onOpenResult).toBeUndefined();
});

it('keeps a dictation that started before account data first loaded', async () => {
  const accountState = jest.mocked(useAccountData.getState);
  let loaded!: () => void;
  jest.mocked(bootAppData).mockReturnValueOnce(new Promise<void>((resolve) => (loaded = resolve)));
  jest.mocked(processAndroidAudio).mockResolvedValueOnce('First words.');
  accountState.mockReturnValue({ owner: '', error: null, blocked: false } as never);
  mockScopeChange(); // the pipeline now remembers "no owner yet"
  mockListeners.onStart({ selection: '' });
  mockListeners.onRecording(audio);
  accountState.mockReturnValue({ owner: 'user-1', error: null, blocked: false } as never);
  mockScopeChange(); // auth loads the owner during the boot
  loaded();
  await flush();
  expect(native.insert).toHaveBeenCalledWith('First words.', { highlight: false });
});

it('a recording after the account changed ends on Retry instead of hanging', async () => {
  mockListeners.onStart({ selection: '' });
  mockScopeChange(); // signed into another account mid-dictation
  mockListeners.onRecording(audio);
  await flush();
  expect(processAndroidAudio).not.toHaveBeenCalled();
  expect(native.setStatus).toHaveBeenLastCalledWith('retry', { message: 'failed' });
  expect(FileSystem.deleteAsync).toHaveBeenCalledWith(audio.uri, { idempotent: true });
});

it('a dictation cut off by an account change mid-processing still ends on Retry', async () => {
  let finish!: (text: string) => void;
  jest
    .mocked(processAndroidAudio)
    .mockImplementationOnce(() => new Promise<string>((resolve) => (finish = resolve)));
  mockListeners.onStart({ selection: '' });
  mockListeners.onRecording(audio);
  await flush();
  mockScopeChange(); // signed into another account while it was being written up
  finish('Too late.');
  await flush();
  expect(native.insert).not.toHaveBeenCalled();
  expect(native.setStatus).toHaveBeenLastCalledWith('retry', { message: 'failed' });
});

it('a cancelled dictation does not report Retry', async () => {
  let finish!: (text: string) => void;
  jest
    .mocked(processAndroidAudio)
    .mockImplementationOnce(() => new Promise<string>((resolve) => (finish = resolve)));
  mockListeners.onStart({ selection: '' });
  mockListeners.onRecording(audio);
  await flush();
  mockListeners.onCancel();
  finish('Cancelled.');
  await flush();
  expect(native.insert).not.toHaveBeenCalled();
  expect(native.setStatus).not.toHaveBeenCalledWith('retry', expect.anything());
});

it('an account change after a cancel does not report Retry', async () => {
  let finish!: (text: string) => void;
  jest
    .mocked(processAndroidAudio)
    .mockImplementationOnce(() => new Promise<string>((resolve) => (finish = resolve)));
  mockListeners.onStart({ selection: '' });
  mockListeners.onRecording(audio);
  await flush();
  mockListeners.onCancel();
  mockScopeChange();
  finish('Cancelled.');
  await flush();
  expect(native.setStatus).not.toHaveBeenCalledWith('retry', expect.anything());
});

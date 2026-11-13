const mockCalls: string[] = [];
const mockStep = (name: string) =>
  jest.fn(async () => {
    mockCalls.push(name);
  });
const mockLoadConfig = mockStep('config');
const mockInitializeAuth = mockStep('auth');
const mockLoadTranscripts = mockStep('transcripts');
const mockLoadDictionary = mockStep('dictionary');
const mockLoadSnippets = mockStep('snippets');

jest.mock('@/store/useConfigStore', () => ({
  useConfigStore: { getState: () => ({ loadConfig: mockLoadConfig }) },
}));
jest.mock('@/store/useAuthStore', () => ({
  useAuthStore: { getState: () => ({ initialize: mockInitializeAuth }) },
}));
jest.mock('@/store/useTranscriptStore', () => ({
  useTranscriptStore: { getState: () => ({ loadTranscripts: mockLoadTranscripts }) },
}));
jest.mock('@/store/useDictionaryStore', () => ({
  useDictionaryStore: { getState: () => ({ load: mockLoadDictionary }) },
}));
jest.mock('@/store/useSnippetsStore', () => ({
  useSnippetsStore: { getState: () => ({ load: mockLoadSnippets }) },
}));

import { bootAppData, forgetAppData } from '../appData';

beforeEach(() => {
  jest.clearAllMocks();
  mockCalls.length = 0;
  forgetAppData();
});

it('loads config before auth and auth before the data stores', async () => {
  await bootAppData();
  expect(mockCalls.slice(0, 2)).toEqual(['config', 'auth']);
  expect(mockCalls.slice(2).sort()).toEqual(['dictionary', 'snippets', 'transcripts']);
});

it('boots once for concurrent callers', async () => {
  const first = bootAppData();
  const second = bootAppData();
  expect(second).toBe(first);
  await first;
  await bootAppData();
  expect(mockLoadConfig).toHaveBeenCalledTimes(1);
  expect(mockInitializeAuth).toHaveBeenCalledTimes(1);
});

it('a failed boot runs again on the next call', async () => {
  mockInitializeAuth.mockRejectedValueOnce(new Error('offline'));
  await expect(bootAppData()).rejects.toThrow('offline');
  await bootAppData();
  expect(mockLoadConfig).toHaveBeenCalledTimes(2);
  expect(mockLoadSnippets).toHaveBeenCalledTimes(1);
});

it('forgetAppData makes the next call boot again', async () => {
  await bootAppData();
  forgetAppData();
  await bootAppData();
  expect(mockLoadConfig).toHaveBeenCalledTimes(2);
});

it('an older load failing does not undo a newer one', async () => {
  let failOld!: (error: Error) => void;
  mockLoadConfig.mockImplementationOnce(
    () => new Promise<void>((_resolve, reject) => (failOld = reject)),
  );
  const old = bootAppData();
  forgetAppData(); // the app's Retry
  const fresh = bootAppData();
  failOld(new Error('offline'));
  await expect(old).rejects.toThrow('offline');
  await fresh;
  expect(bootAppData()).toBe(fresh);
});

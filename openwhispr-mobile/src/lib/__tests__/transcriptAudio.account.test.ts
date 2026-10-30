const mockFiles = new Set<string>();
const directory = 'file:///cache/transcript-audio/';
const mockInfo = jest.fn();
const mockList = jest.fn();
const mockDelete = jest.fn(async (uri: string) => {
  mockFiles.delete(uri);
});
jest.mock('expo-file-system/legacy', () => ({
  cacheDirectory: 'file:///cache/',
  getInfoAsync: (uri: string) => mockInfo(uri),
  readDirectoryAsync: (uri: string) => mockList(uri),
  makeDirectoryAsync: async () => {},
  copyAsync: async ({ to }: { to: string }) => {
    mockFiles.add(to);
  },
  deleteAsync: (uri: string) => mockDelete(uri),
}));
jest.mock('../meetingAudioStorage', () => ({ meetingAudioDirectory: () => '' }));
import { garbageCollectTranscriptAudio, retainTranscriptAudio } from '../transcriptAudio';

beforeEach(() => {
  jest.clearAllMocks();
  mockFiles.clear();
  mockInfo.mockImplementation(async (uri: string) => ({
    exists: uri === directory || mockFiles.has(uri),
  }));
  mockList.mockImplementation(async () =>
    [...mockFiles]
      .filter((uri) => uri.startsWith(directory))
      .map((uri) => uri.slice(directory.length)),
  );
});

it('stops A’s paused collector when B starts an upload after switching accounts', async () => {
  let resume!: (value: { exists: boolean }) => void;
  mockInfo.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        resume = resolve;
      }),
  );
  let current = true;
  const collection = garbageCollectTranscriptAudio([], {
    isCurrent: () => current,
    currentKeepUris: () => [],
  });
  current = false;
  mockFiles.add('file:///picked/b.wav');
  const retained = await retainTranscriptAudio('file:///picked/b.wav', {
    transcriptId: 'b-active',
  });
  resume({ exists: true });
  await collection;
  expect(mockFiles.has(retained)).toBe(true);
  expect(mockDelete).not.toHaveBeenCalledWith(retained);
});

it('protects active audio that is copied while the collector is listing the directory', async () => {
  let resume!: (files: string[]) => void;
  let listing!: () => void;
  const ready = new Promise<void>((resolve) => {
    listing = resolve;
  });
  mockList.mockImplementationOnce(() => {
    listing();
    return new Promise((resolve) => {
      resume = resolve;
    });
  });
  const collection = garbageCollectTranscriptAudio([]);
  await ready;
  mockFiles.add('file:///picked/active.wav');
  const retained = await retainTranscriptAudio('file:///picked/active.wav', {
    transcriptId: 'active-copy',
  });
  resume(['active-copy.wav', 'orphan.wav']);
  mockFiles.add(`${directory}orphan.wav`);
  await collection;
  expect(mockFiles.has(retained)).toBe(true);
  expect(mockFiles.has(`${directory}orphan.wav`)).toBe(false);
});

it('refreshes saved audio references after asynchronous filesystem reads', async () => {
  const retained = `${directory}newly-saved.wav`;
  let resume!: (files: string[]) => void;
  let listing!: () => void;
  const ready = new Promise<void>((resolve) => {
    listing = resolve;
  });
  mockList.mockImplementationOnce(() => {
    listing();
    return new Promise((resolve) => {
      resume = resolve;
    });
  });
  const keep: string[] = [];
  const collection = garbageCollectTranscriptAudio([], {
    isCurrent: () => true,
    currentKeepUris: () => keep,
  });
  await ready;
  mockFiles.add(retained);
  keep.push(retained);
  resume(['newly-saved.wav']);
  await collection;
  expect(mockFiles.has(retained)).toBe(true);
});

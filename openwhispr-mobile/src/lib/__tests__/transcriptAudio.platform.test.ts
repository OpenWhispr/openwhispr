import * as ios from '../transcriptAudio';
import * as android from '../transcriptAudio.android';

const mockFiles = new Set<string>();
const directory = 'file:///cache/transcript-audio/';
const mockCopy = jest.fn(async ({ to }: { to: string }) => {
  mockFiles.add(to);
});
const mockDelete = jest.fn(async (uri: string) => {
  mockFiles.delete(uri);
});
jest.mock('expo-file-system/legacy', () => ({
  cacheDirectory: 'file:///cache/',
  documentDirectory: 'file:///docs/',
  getInfoAsync: async (uri: string) => ({ exists: uri === directory || mockFiles.has(uri) }),
  readDirectoryAsync: async () =>
    [...mockFiles]
      .filter((uri) => uri.startsWith(directory))
      .map((uri) => uri.slice(directory.length)),
  makeDirectoryAsync: async () => {},
  copyAsync: (input: { to: string }) => mockCopy(input),
  deleteAsync: (uri: string) => mockDelete(uri),
}));
jest.mock('../meetingAudioStorage', () => ({
  meetingAudioDirectory: () => 'file:///docs/account-audio/fixture/',
}));

describe.each([
  { platform: 'ios', audio: ios },
  { platform: 'android', audio: android },
])('$platform retained audio', ({ platform, audio }) => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockFiles.clear();
  });
  it('uses the platform meeting directory', () => {
    expect(audio.isManagedMeetingAudioUri(7, 'file:///docs/meeting-7.wav')).toBe(
      platform === 'ios',
    );
    expect(
      audio.isManagedMeetingAudioUri(7, 'file:///docs/account-audio/fixture/meeting-7.wav'),
    ).toBe(platform === 'android');
  });
  it('preserves the platform copy lease until release', async () => {
    mockFiles.add('file:///picked/lease.wav');
    const retained = await audio.retainTranscriptAudio('file:///picked/lease.wav', {
      transcriptId: 'lease',
    });
    await audio.garbageCollectTranscriptAudio([]);
    expect(mockFiles.has(retained)).toBe(platform === 'android');
    if (platform === 'android') {
      android.releaseTranscriptAudio(retained);
      await audio.garbageCollectTranscriptAudio([]);
      expect(mockFiles.has(retained)).toBe(false);
    } else expect(audio).not.toHaveProperty('releaseTranscriptAudio');
  });
  it('does not leave a lease after copying fails', async () => {
    mockFiles.add('file:///picked/failed.wav');
    mockCopy.mockRejectedValueOnce(new Error('Copy failed'));
    await expect(
      audio.retainTranscriptAudio('file:///picked/failed.wav', { transcriptId: 'failed' }),
    ).rejects.toThrow('Copy failed');
    mockFiles.add(`${directory}failed.wav`);
    await audio.garbageCollectTranscriptAudio([]);
    expect(mockFiles.has(`${directory}failed.wav`)).toBe(false);
  });
  it('preserves audio with a durable row', async () => {
    const retained = `${directory}durable.wav`;
    mockFiles.add(retained);
    await audio.garbageCollectTranscriptAudio([retained]);
    expect(mockFiles.has(retained)).toBe(true);
    expect(mockDelete).not.toHaveBeenCalled();
  });
});

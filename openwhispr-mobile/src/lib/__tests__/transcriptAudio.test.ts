const mockFiles = new Map<string, string>();
jest.mock('expo-file-system/legacy', () => ({
  documentDirectory: 'file:///docs/',
  cacheDirectory: 'file:///cache/',
  writeAsStringAsync: jest.fn(async (uri: string, content: string) => {
    mockFiles.set(uri, content);
  }),
  readAsStringAsync: jest.fn(async (uri: string) => {
    const content = mockFiles.get(uri);
    if (content === undefined) throw new Error('missing');
    return content;
  }),
  getInfoAsync: jest.fn(async (uri: string) => ({ exists: mockFiles.has(uri) })),
  deleteAsync: jest.fn(async (uri: string) => {
    mockFiles.delete(uri);
  }),
}));

const mockExcludeFromBackup = jest.fn(async (_uri: string): Promise<boolean> => true);
jest.mock('../../../modules/live-pcm-streaming/src', () => ({
  LivePCMStreaming: { excludeFromBackup: (uri: string) => mockExcludeFromBackup(uri) },
}));

import * as FileSystem from 'expo-file-system/legacy';
import {
  BACKFILL_RETRY_BASE_MS,
  BACKFILL_RETRY_MAX_MS,
  backfillRetryDelayMs,
  clearPendingBackfill,
  excludeMeetingFileFromBackup,
  hasPendingBackfillFile,
  isManagedMeetingAudioUri,
  meetingBackfillUri,
  meetingRecordingUri,
  isBackfillRetryDue,
  readPendingBackfill,
  readPendingBackfillState,
  savePendingBackfill,
  saveRecordingAwaitingConnection,
} from '@/lib/transcriptAudio';

describe('meetingRecordingUri', () => {
  it('is the one path a meeting records to, and is recognised as managed', () => {
    const uri = meetingRecordingUri(7);
    expect(uri.endsWith('meeting-7.wav')).toBe(true);
    expect(isManagedMeetingAudioUri(7, uri)).toBe(true);
    expect(isManagedMeetingAudioUri(8, uri)).toBe(false);
  });
});

describe('pending backfill sidecar', () => {
  beforeEach(() => mockFiles.clear());

  it('sits next to the recording', () => {
    expect(meetingBackfillUri(7)).toBe('file:///docs/meeting-7.backfill.json');
  });

  it('round-trips the windows', async () => {
    const windows = [
      { startMs: 1000, endMs: 121_000 },
      { startMs: 300_000, endMs: 302_500 },
    ];
    await savePendingBackfill(7, windows);
    expect(JSON.parse(mockFiles.get(meetingBackfillUri(7)) ?? '')).toEqual({ version: 1, windows });
    await expect(readPendingBackfill(7)).resolves.toEqual(windows);
  });

  it('reads null when there is no sidecar', async () => {
    await expect(readPendingBackfill(7)).resolves.toBeNull();
  });

  it.each([
    ['not JSON', '{'],
    ['another version', JSON.stringify({ version: 2, windows: [] })],
    ['no windows', JSON.stringify({ version: 1 })],
    ['a non-number', JSON.stringify({ version: 1, windows: [{ startMs: '1', endMs: 2 }] })],
    ['a non-finite number', '{"version":1,"windows":[{"startMs":0,"endMs":1e999}]}'],
    ['a window that is not an object', JSON.stringify({ version: 1, windows: [null] })],
  ])('reads null for %s', async (_label, content) => {
    mockFiles.set(meetingBackfillUri(7), content);
    await expect(readPendingBackfill(7)).resolves.toBeNull();
  });

  it('clears idempotently and never throws', async () => {
    await savePendingBackfill(7, [{ startMs: 0, endMs: 1 }]);
    await clearPendingBackfill(7);
    expect(mockFiles.has(meetingBackfillUri(7))).toBe(false);
    await expect(clearPendingBackfill(7)).resolves.toBeUndefined();
    jest.mocked(FileSystem.deleteAsync).mockRejectedValueOnce(new Error('disk'));
    await expect(clearPendingBackfill(7)).resolves.toBeUndefined();
  });

  it('keeps a done meeting recording whose sidecar cannot be read', async () => {
    // The launch clean-up asks this, not readPendingBackfill: a sidecar it can't parse still
    // means the recording owes audio.
    mockFiles.set(meetingBackfillUri(7), '{');
    await expect(readPendingBackfill(7)).resolves.toBeNull();
    await expect(hasPendingBackfillFile(7)).resolves.toBe(true);
    await expect(hasPendingBackfillFile(8)).resolves.toBe(false);
    jest.mocked(FileSystem.getInfoAsync).mockRejectedValueOnce(new Error('stat'));
    await expect(hasPendingBackfillFile(8)).resolves.toBe(true);
  });

  it('rejects when the sidecar cannot be saved', async () => {
    jest.mocked(FileSystem.writeAsStringAsync).mockRejectedValueOnce(new Error('full'));
    await expect(savePendingBackfill(7, [{ startMs: 0, endMs: 1 }])).rejects.toThrow('full');
  });
});

describe('a whole recording waiting for a connection', () => {
  beforeEach(() => mockFiles.clear());

  it('round-trips the account it may go up under, with no windows', async () => {
    await saveRecordingAwaitingConnection(7, 'user-1');
    expect(JSON.parse(mockFiles.get(meetingBackfillUri(7)) ?? '')).toEqual({
      version: 1,
      windows: [],
      awaitingConnection: { accountId: 'user-1' },
    });
    await expect(readPendingBackfillState(7)).resolves.toEqual({
      windows: [],
      attempts: 0,
      lastAttemptAt: 0,
      awaitingConnection: { accountId: 'user-1' },
    });
    expect(mockExcludeFromBackup).toHaveBeenCalledWith(meetingBackfillUri(7));
  });

  it('keeps a signed-out owner and the attempts', async () => {
    await saveRecordingAwaitingConnection(7, null, { attempts: 2, lastAttemptAt: 5_000 });
    await expect(readPendingBackfillState(7)).resolves.toEqual({
      windows: [],
      attempts: 2,
      lastAttemptAt: 5_000,
      awaitingConnection: { accountId: null },
    });
  });

  it('reads an owed-audio list as not waiting', async () => {
    await savePendingBackfill(7, [{ startMs: 0, endMs: 1000 }]);
    const state = await readPendingBackfillState(7);
    expect(state).not.toHaveProperty('awaitingConnection');
  });

  it('is never read as an empty list, which would mean nothing is owed', async () => {
    await savePendingBackfill(7, []);
    await expect(readPendingBackfill(7)).resolves.toEqual([]);
    await saveRecordingAwaitingConnection(7, 'user-1');
    await expect(readPendingBackfill(7)).resolves.toBeNull();
  });

  it.each([
    ['no account', JSON.stringify({ version: 1, windows: [], awaitingConnection: {} })],
    [
      'a non-string account',
      JSON.stringify({ version: 1, windows: [], awaitingConnection: { accountId: 4 } }),
    ],
    ['a non-object', JSON.stringify({ version: 1, windows: [], awaitingConnection: true })],
  ])('reads null for %s, so nothing goes up under a guessed account', async (_label, content) => {
    mockFiles.set(meetingBackfillUri(7), content);
    await expect(readPendingBackfillState(7)).resolves.toBeNull();
  });

  it('rejects when it cannot be saved', async () => {
    jest.mocked(FileSystem.writeAsStringAsync).mockRejectedValueOnce(new Error('full'));
    await expect(saveRecordingAwaitingConnection(7, 'user-1')).rejects.toThrow('full');
  });
});

describe('owed-audio retry backoff', () => {
  beforeEach(() => mockFiles.clear());
  const MIN = 60_000;

  it('keeps the attempts beside the windows', async () => {
    const windows = [{ startMs: 0, endMs: 1000 }];
    await savePendingBackfill(7, windows, { attempts: 2, lastAttemptAt: 5_000 });
    expect(JSON.parse(mockFiles.get(meetingBackfillUri(7)) ?? '')).toEqual({
      version: 1,
      windows,
      attempts: 2,
      lastAttemptAt: 5_000,
    });
    await expect(readPendingBackfillState(7)).resolves.toEqual({
      windows,
      attempts: 2,
      lastAttemptAt: 5_000,
    });
    // The plain reader still reads the same file.
    await expect(readPendingBackfill(7)).resolves.toEqual(windows);
  });

  it('reads a file without attempts, or with bad ones, as never tried', async () => {
    const windows = [{ startMs: 0, endMs: 1000 }];
    mockFiles.set(meetingBackfillUri(7), JSON.stringify({ version: 1, windows }));
    await expect(readPendingBackfillState(7)).resolves.toEqual({
      windows,
      attempts: 0,
      lastAttemptAt: 0,
    });
    for (const [attempts, lastAttemptAt] of [
      ['3', 'x'],
      [-2, null],
      [Number.POSITIVE_INFINITY, Number.NaN],
    ]) {
      // JSON can't carry Infinity or NaN; written as strings they must still read as 0.
      mockFiles.set(
        meetingBackfillUri(7),
        `{"version":1,"windows":${JSON.stringify(windows)},"attempts":${JSON.stringify(
          attempts,
        )},"lastAttemptAt":${JSON.stringify(lastAttemptAt)}}`,
      );
      await expect(readPendingBackfillState(7)).resolves.toEqual({
        windows,
        attempts: 0,
        lastAttemptAt: 0,
      });
    }
    mockFiles.set(
      meetingBackfillUri(7),
      `{"version":1,"windows":${JSON.stringify(windows)},"attempts":1e999,"lastAttemptAt":1e999}`,
    );
    await expect(readPendingBackfillState(7)).resolves.toEqual({
      windows,
      attempts: 0,
      lastAttemptAt: 0,
    });
  });

  it('doubles the wait per failed attempt from 5 minutes up to 6 hours', () => {
    expect(BACKFILL_RETRY_BASE_MS).toBe(5 * MIN);
    expect(BACKFILL_RETRY_MAX_MS).toBe(6 * 60 * MIN);
    expect(backfillRetryDelayMs(0)).toBe(0);
    expect(backfillRetryDelayMs(1)).toBe(5 * MIN);
    expect(backfillRetryDelayMs(2)).toBe(10 * MIN);
    expect(backfillRetryDelayMs(3)).toBe(20 * MIN);
    expect(backfillRetryDelayMs(7)).toBe(320 * MIN);
    expect(backfillRetryDelayMs(8)).toBe(6 * 60 * MIN);
    expect(backfillRetryDelayMs(500)).toBe(6 * 60 * MIN);
  });

  it('is due when never tried, once the wait is over, or when the clock went back', () => {
    const now = 10_000_000;
    expect(isBackfillRetryDue({ attempts: 0, lastAttemptAt: now }, now)).toBe(true);
    expect(isBackfillRetryDue({ attempts: 1, lastAttemptAt: now - 5 * MIN + 1 }, now)).toBe(false);
    expect(isBackfillRetryDue({ attempts: 1, lastAttemptAt: now - 5 * MIN }, now)).toBe(true);
    expect(isBackfillRetryDue({ attempts: 2, lastAttemptAt: now - 9 * MIN }, now)).toBe(false);
    expect(isBackfillRetryDue({ attempts: 1, lastAttemptAt: now + 60 * MIN }, now)).toBe(true);
  });
});

describe('keeping meeting files out of backups', () => {
  beforeEach(() => {
    mockFiles.clear();
    mockExcludeFromBackup.mockReset().mockResolvedValue(true);
  });

  it('excludes the sidecar every time it is written', async () => {
    // Each write may replace the file, and a replaced file loses the mark.
    await savePendingBackfill(7, [{ startMs: 0, endMs: 1000 }]);
    await savePendingBackfill(7, []);

    expect(mockExcludeFromBackup.mock.calls).toEqual([
      [meetingBackfillUri(7)],
      [meetingBackfillUri(7)],
    ]);
  });

  it('still saves the sidecar when it cannot be excluded', async () => {
    mockExcludeFromBackup.mockRejectedValue(new Error('no native module'));

    await expect(savePendingBackfill(7, [{ startMs: 0, endMs: 1000 }])).resolves.toBeUndefined();
    await expect(readPendingBackfill(7)).resolves.toEqual([{ startMs: 0, endMs: 1000 }]);
  });

  it('never throws for a file it cannot exclude', async () => {
    mockExcludeFromBackup.mockRejectedValue(new Error('missing'));

    await expect(excludeMeetingFileFromBackup(meetingRecordingUri(7))).resolves.toBeUndefined();
    expect(mockExcludeFromBackup).toHaveBeenCalledWith(meetingRecordingUri(7));
  });
});

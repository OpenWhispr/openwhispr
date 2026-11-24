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

import * as FileSystem from 'expo-file-system/legacy';
import {
  clearPendingBackfill,
  hasPendingBackfillFile,
  isManagedMeetingAudioUri,
  meetingBackfillUri,
  meetingRecordingUri,
  readPendingBackfill,
  savePendingBackfill,
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

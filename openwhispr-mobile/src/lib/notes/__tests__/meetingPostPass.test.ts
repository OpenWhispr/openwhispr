const mockTranscribe = jest.fn();
const mockGetInfo = jest.fn();
jest.mock('expo-file-system/legacy', () => ({
  documentDirectory: 'file:///app/documents/',
  cacheDirectory: 'file:///app/cache/',
  getInfoAsync: (...args: unknown[]) => mockGetInfo(...args),
  deleteAsync: jest.fn(async () => undefined),
}));
jest.mock('@/services/transcription/TranscriptionService', () => ({
  TranscriptionService: { transcribe: (...args: unknown[]) => mockTranscribe(...args) },
}));
jest.mock('@/lib/permissions', () => ({
  isNoSpeechError: (error: unknown) => error instanceof Error && /no speech/i.test(error.message),
}));

import {
  BACKFILL_CHUNK_MS,
  BACKFILL_MIN_MS,
  OWED_GAP_MIN_MS,
  backfillDroppedAudio,
  createCloudPostPassDeps,
  mergeTranscript,
  owedWindowsFromSegments,
  transcribeRecordingToSegments,
  type PostPassDeps,
} from '../meetingPostPass';
import type { CloudMeetingSegment } from '../cloudMeetingSegments';

const RECORDING = 'file:///app/documents/meeting-7.wav';

const makeDeps = (texts: Record<number, string | Error | Error[]> = {}): PostPassDeps => {
  const attempts = new Map<number, number>();
  return {
    extract: jest.fn(
      async (_uri: string, startMs: number) => `file:///app/cache/range-${startMs}.wav`,
    ),
    transcribe: jest.fn(async (uri: string) => {
      const startMs = Number(/range-(\d+)\.wav$/.exec(uri)?.[1]);
      const attempt = attempts.get(startMs) ?? 0;
      attempts.set(startMs, attempt + 1);
      const outcome = texts[startMs];
      if (Array.isArray(outcome)) {
        const next = outcome[attempt];
        if (next instanceof Error) throw next;
        return next ?? `text at ${startMs}`;
      }
      if (outcome instanceof Error) throw outcome;
      return outcome ?? `text at ${startMs}`;
    }),
    cleanup: jest.fn(async () => undefined),
  };
};

const seg = (text: string, startMs: number, sortOrder: number): CloudMeetingSegment => ({
  text,
  startMs,
  endMs: startMs + 1000,
  speakerLabel: null,
  sortOrder,
});

describe('backfillDroppedAudio', () => {
  it('uses two-minute pieces and skips pieces under two seconds', () => {
    expect(BACKFILL_CHUNK_MS).toBe(120_000);
    expect(BACKFILL_MIN_MS).toBe(2000);
  });

  it('transcribes each dropped stretch in pieces of at most two minutes', async () => {
    const deps = makeDeps();
    await backfillDroppedAudio(RECORDING, [{ startMs: 0, endMs: 250_000 }], deps);
    expect((deps.extract as jest.Mock).mock.calls).toEqual([
      [RECORDING, 0, 120_000],
      [RECORDING, 120_000, 240_000],
      [RECORDING, 240_000, 250_000],
    ]);
  });

  it('places backfilled text at the start of its stretch', async () => {
    const deps = makeDeps({ 120_000: '  Second piece.  ' });
    const { segments, failed } = await backfillDroppedAudio(
      RECORDING,
      [{ startMs: 0, endMs: 250_000 }],
      deps,
    );
    expect(failed).toBe(0);
    expect(segments[1]).toEqual({
      text: 'Second piece.',
      startMs: 120_000,
      endMs: 240_000,
      speakerLabel: null,
      sortOrder: 1,
    });
  });

  it('tries a failed stretch once more, then stops and returns it with the rest as failed', async () => {
    const deps = makeDeps({ 120_000: new Error('offline') });
    const { segments, failed, failedWindows } = await backfillDroppedAudio(
      RECORDING,
      [
        { startMs: 0, endMs: 250_000 },
        { startMs: 400_000, endMs: 401_000 },
        { startMs: 500_000, endMs: 510_000 },
      ],
      deps,
    );
    const calls = (deps.transcribe as jest.Mock).mock.calls.map(([uri]) => uri);
    expect(calls.filter((uri) => uri.endsWith('range-120000.wav'))).toHaveLength(2);
    // Offline, every later piece would wait out the same timeouts: none is tried.
    expect(deps.extract).toHaveBeenCalledTimes(2);
    expect(failed).toBe(3);
    expect(failedWindows).toEqual([
      { startMs: 120_000, endMs: 240_000 },
      { startMs: 240_000, endMs: 250_000 },
      { startMs: 500_000, endMs: 510_000 },
    ]);
    expect(segments.map((s) => s.startMs)).toEqual([0]);
  });

  it('does not stop at a stretch the recording cannot give', async () => {
    const deps = makeDeps();
    (deps.extract as jest.Mock).mockRejectedValueOnce(new Error('Recording has no audio'));
    const { segments, failed, failedWindows } = await backfillDroppedAudio(
      RECORDING,
      [
        { startMs: 0, endMs: 10_000 },
        { startMs: 20_000, endMs: 30_000 },
      ],
      deps,
    );
    expect(failed).toBe(0);
    expect(failedWindows).toEqual([]);
    expect(segments.map((s) => s.startMs)).toEqual([20_000]);
  });

  it('keeps a stretch whose second try succeeds', async () => {
    const deps = makeDeps({ 0: [new Error('timeout'), 'Got it.'] as unknown as Error[] });
    const { segments, failed } = await backfillDroppedAudio(
      RECORDING,
      [{ startMs: 0, endMs: 10_000 }],
      deps,
    );
    expect(failed).toBe(0);
    expect(segments.map((s) => s.text)).toEqual(['Got it.']);
  });

  it('skips silence', async () => {
    const deps = makeDeps({ 0: '   ', 120_000: '' });
    const { segments, failed } = await backfillDroppedAudio(
      RECORDING,
      [{ startMs: 0, endMs: 240_000 }],
      deps,
    );
    expect(segments).toEqual([]);
    expect(failed).toBe(0);
    // Silence is an answer, not a failure: it is not asked again.
    expect(deps.transcribe).toHaveBeenCalledTimes(2);
  });

  it('skips a stretch the recording does not hold', async () => {
    const deps = makeDeps();
    (deps.extract as jest.Mock).mockImplementation(async (_uri: string, startMs: number) => {
      if (startMs === 0) throw new Error('Recording has no audio in that range');
      return `file:///app/cache/range-${startMs}.wav`;
    });
    const { segments, failed } = await backfillDroppedAudio(
      RECORDING,
      [
        { startMs: 0, endMs: 10_000 },
        { startMs: 20_000, endMs: 30_000 },
      ],
      deps,
    );
    expect(failed).toBe(0);
    expect(segments.map((s) => s.startMs)).toEqual([20_000]);
  });

  it('always cleans up the extracted file', async () => {
    const deps = makeDeps({ 120_000: '', 240_000: new Error('offline') });
    await backfillDroppedAudio(RECORDING, [{ startMs: 0, endMs: 250_000 }], deps);
    expect((deps.cleanup as jest.Mock).mock.calls).toEqual([
      ['file:///app/cache/range-0.wav'],
      ['file:///app/cache/range-120000.wav'],
      ['file:///app/cache/range-240000.wav'],
    ]);
  });

  it('never rejects, even when cleanup throws', async () => {
    const deps = makeDeps();
    (deps.cleanup as jest.Mock).mockRejectedValue(new Error('disk'));
    await expect(
      backfillDroppedAudio(RECORDING, [{ startMs: 0, endMs: 10_000 }], deps),
    ).resolves.toEqual({
      segments: [expect.objectContaining({ text: 'text at 0' })],
      failed: 0,
      failedWindows: [],
    });
  });
});

describe('mergeTranscript', () => {
  it('orders live and backfilled segments by start and renumbers them', () => {
    const live = [seg('a', 0, 0), seg('d', 300_000, 1)];
    const backfilled = [seg('b', 120_000, 0), seg('c', 240_000, 1)];
    const merged = mergeTranscript(live, backfilled);
    expect(merged.map((s) => s.text)).toEqual(['a', 'b', 'c', 'd']);
    expect(merged.map((s) => s.sortOrder)).toEqual([0, 1, 2, 3]);
  });

  it('puts live text first when a backfilled piece starts at the same time', () => {
    const merged = mergeTranscript(
      [seg('live', 5000, 0)],
      [{ ...seg('backfilled', 5000, 0), endMs: 125_000 }],
    );
    expect(merged.map((s) => s.text)).toEqual(['live', 'backfilled']);
  });

  it('skips a backfilled piece already in the note from an earlier resume', () => {
    const earlier = { ...seg('piece', 10_000, 0), endMs: 20_000 };
    const merged = mergeTranscript(
      [seg('live', 0, 0), earlier],
      [{ ...earlier, text: 'piece again' }, seg('new', 30_000, 1)],
    );
    expect(merged.map((s) => s.text)).toEqual(['live', 'piece', 'new']);
  });

  it('keeps a backfilled piece whose window matches only a labelled row', () => {
    const labelled = { ...seg('live', 10_000, 0), endMs: 20_000, speakerLabel: 'SPEAKER_00' };
    const merged = mergeTranscript([labelled], [{ ...labelled, speakerLabel: null, text: 'b' }]);
    expect(merged.map((s) => s.text)).toEqual(['live', 'b']);
  });

  it('never alters a live segment', () => {
    const live = [{ ...seg('kept', 1000, 4), endMs: 9000 }];
    const merged = mergeTranscript(live, []);
    expect(merged).toEqual([{ ...live[0], sortOrder: 0 }]);
    expect(live[0].sortOrder).toBe(4);
  });
});

describe('owedWindowsFromSegments', () => {
  const at = (startMs: number, endMs: number): { startMs: number; endMs: number } => ({
    startMs,
    endMs,
  });

  it('owes the head, long gaps and the tail', () => {
    expect(OWED_GAP_MIN_MS).toBe(15_000);
    expect(owedWindowsFromSegments([at(5000, 10_000), at(40_000, 50_000)], 60_000)).toEqual([
      at(0, 5000),
      at(10_000, 40_000),
      at(50_000, 60_000),
    ]);
  });

  it('ignores a gap shorter than 15 seconds', () => {
    expect(owedWindowsFromSegments([at(0, 10_000), at(24_000, 30_000)], 30_000)).toEqual([]);
  });

  it('measures gaps from the furthest end when segments overlap', () => {
    expect(
      owedWindowsFromSegments([at(0, 50_000), at(10_000, 20_000), at(60_000, 70_000)], 70_000),
    ).toEqual([]);
    // Out of order: sorted by start, so the 5-second gap is not owed.
    expect(owedWindowsFromSegments([at(40_000, 60_000), at(0, 20_000)], 60_000)).toEqual([
      at(20_000, 40_000),
    ]);
  });

  it('owes the whole file when nothing was saved', () => {
    expect(owedWindowsFromSegments([], 90_000)).toEqual([at(0, 90_000)]);
  });

  it('drops pieces shorter than the backfill minimum and values it cannot trust', () => {
    expect(
      owedWindowsFromSegments(
        [at(BACKFILL_MIN_MS - 1, 10_000), at(Number.NaN, 5), at(30_000, 20_000)],
        10_000 + BACKFILL_MIN_MS - 1,
      ),
    ).toEqual([]);
    expect(owedWindowsFromSegments([], Number.NaN)).toEqual([]);
  });
});

describe('cloud transcription of a recording', () => {
  beforeEach(() => {
    mockTranscribe.mockReset();
    mockGetInfo.mockReset();
  });

  it('sends a stretch as a meeting recording without cleanup', async () => {
    mockTranscribe.mockResolvedValue({ text: 'Hello', duration: 1, provider: 'cloud' });
    await expect(createCloudPostPassDeps('de').transcribe('file:///app/cache/r.wav')).resolves.toBe(
      'Hello',
    );
    expect(mockTranscribe).toHaveBeenCalledWith({
      audioUri: 'file:///app/cache/r.wav',
      provider: 'cloud',
      purpose: 'meeting',
      requestContext: 'recording',
      fileName: 'meeting.wav',
      mimeType: 'audio/wav',
      language: 'de',
    });
  });

  it('reads no speech as silence', async () => {
    mockTranscribe.mockRejectedValue(new Error('No speech detected'));
    await expect(createCloudPostPassDeps(undefined).transcribe('file:///x.wav')).resolves.toBe('');
    await expect(transcribeRecordingToSegments(RECORDING, undefined)).resolves.toEqual([]);
  });

  it('times chunked text on the recording clock', async () => {
    mockTranscribe.mockResolvedValue({
      text: 'one two',
      duration: 0,
      provider: 'cloud',
      segments: [
        { text: ' one ', t0: 0, t1: 12_000 },
        { text: 'two', t0: 24_000, t1: 36_000 },
      ],
    });
    await expect(transcribeRecordingToSegments(RECORDING, undefined)).resolves.toEqual([
      { text: 'one', startMs: 0, endMs: 120_000, speakerLabel: null, sortOrder: 0 },
      { text: 'two', startMs: 240_000, endMs: 360_000, speakerLabel: null, sortOrder: 1 },
    ]);
  });

  it('spans a short recording sent whole with one segment', async () => {
    mockTranscribe.mockResolvedValue({ text: ' Short. ', duration: 0, provider: 'cloud' });
    mockGetInfo.mockResolvedValue({ exists: true, size: 44 + 32 * 5000 });
    await expect(transcribeRecordingToSegments(RECORDING, undefined)).resolves.toEqual([
      { text: 'Short.', startMs: 0, endMs: 5000, speakerLabel: null, sortOrder: 0 },
    ]);
  });

  it('rejects when the cloud cannot be reached', async () => {
    mockTranscribe.mockRejectedValue(new Error('Network request failed'));
    await expect(transcribeRecordingToSegments(RECORDING, undefined)).rejects.toThrow('Network');
  });
});

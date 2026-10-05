// src/services/diarization/__tests__/DiarizationService.test.ts
import { processMeeting, type DiarizationDeps } from '../DiarizationService';
import type { DiarizationResult } from '@/lib/diarization/diarizer';
import type { TranscriptionResponse } from '@/types';

const whisperResponse: TranscriptionResponse = {
  text: 'hello there hi',
  duration: 1,
  provider: 'local',
  segments: [
    { text: 'hello', t0: 0, t1: 60 }, // 0..600ms    -> speaker_0
    { text: 'there', t0: 70, t1: 200 }, // 700..2000ms -> speaker_0
    { text: 'hi', t0: 250, t1: 420 }, // 2500..4200ms -> speaker_1
  ],
};

const diarResult: DiarizationResult = {
  speakerCount: 2,
  segments: [
    { start: 0, end: 2.0, speakerId: 0 }, // 0..2000ms
    { start: 2.0, end: 4.5, speakerId: 1 }, // 2000..4500ms
  ],
  embeddings: { 0: [1, 0], 1: [0, 1] },
};

const makeDeps = (overrides: Partial<DiarizationDeps> = {}) => {
  const calls: {
    status: string[];
    seq: string[];
    diarizeArgs?: unknown[];
    segments?: unknown;
    speakers?: unknown;
  } = { status: [], seq: [] };
  const deps: DiarizationDeps = {
    transcribe: async () => whisperResponse,
    diarizer: {
      isAvailable: () => true,
      diarize: async (uri: string, n?: number) => {
        calls.diarizeArgs = [uri, n];
        return diarResult;
      },
    } as unknown as DiarizationDeps['diarizer'],
    repo: {
      getTranscriptionStatus: () => 'recording',
      getSpeakers: () => [],
      replaceSegments: (_id, segs) => {
        calls.segments = segs;
        calls.seq.push('replaceSegments');
      },
      upsertSpeakers: (_id, rows) => {
        calls.speakers = rows;
        calls.seq.push('upsertSpeakers');
      },
      updateSpeaker: () => undefined,
      setTranscriptionStatus: (_id, s) => {
        calls.status.push(s);
        calls.seq.push(`status:${s}`);
      },
    },
    ...overrides,
  };
  return { deps, calls };
};

describe('processMeeting', () => {
  it('drives status transcribing -> diarizing -> done', async () => {
    const { deps, calls } = makeDeps();
    await processMeeting({ noteId: 1, wavUri: 'file://m.wav', expectedSpeakerCount: 2 }, deps);
    expect(calls.status).toEqual(['transcribing', 'diarizing', 'done']);
  });

  it('runs repo ops in the exact order: status -> status -> replaceSegments -> upsertSpeakers -> status', async () => {
    const { deps, calls } = makeDeps();
    await processMeeting({ noteId: 1, wavUri: 'file://m.wav', expectedSpeakerCount: 2 }, deps);
    expect(calls.seq).toEqual([
      'status:transcribing',
      'status:diarizing',
      'replaceSegments',
      'upsertSpeakers',
      'status:done',
    ]);
  });

  it('passes the speaker-count hint to the diarizer', async () => {
    const { deps, calls } = makeDeps();
    await processMeeting({ noteId: 1, wavUri: 'file://m.wav', expectedSpeakerCount: 3 }, deps);
    expect(calls.diarizeArgs).toEqual(['file://m.wav', 3]);
  });

  it('passes 0 (auto) when no count hint is provided', async () => {
    const { deps, calls } = makeDeps();
    await processMeeting({ noteId: 1, wavUri: 'file://m.wav' }, deps);
    expect(calls.diarizeArgs).toEqual(['file://m.wav', 0]);
  });

  it('returns speaker embeddings keyed by persisted speaker labels', async () => {
    const { deps } = makeDeps();
    const result = await processMeeting(
      { noteId: 1, wavUri: 'file://m.wav', expectedSpeakerCount: 2 },
      deps,
    );

    expect(result.speakerEmbeddingsByLabel).toEqual({
      speaker_0: [1, 0],
      speaker_1: [0, 1],
    });
  });

  it('persists merged segments in MS with string speaker labels', async () => {
    const { deps, calls } = makeDeps();
    await processMeeting(
      { noteId: 1, wavUri: 'file://m.wav', expectedSpeakerCount: 2, minSegmentMs: 1500 },
      deps,
    );
    const segs = calls.segments as Array<{
      text: string;
      startMs: number;
      endMs: number;
      speakerLabel: string;
    }>;
    expect(segs).toEqual([
      { noteId: 1, text: 'hello there', startMs: 0, endMs: 2000, speakerLabel: 'speaker_0' },
      { noteId: 1, text: 'hi', startMs: 2500, endMs: 4200, speakerLabel: 'speaker_1' },
    ]);
  });

  it('inserts new speakers as provisional/unlocked (routed through speakerState)', async () => {
    const { deps, calls } = makeDeps();
    await processMeeting({ noteId: 1, wavUri: 'file://m.wav', expectedSpeakerCount: 2 }, deps);
    const spk = calls.speakers as Array<{
      speakerLabel: string;
      speakerStatus: string;
      speakerLocked: number;
    }>;
    expect(spk.map((s) => s.speakerLabel).sort()).toEqual(['speaker_0', 'speaker_1']);
    expect(spk.every((s) => s.speakerStatus === 'provisional' && s.speakerLocked === 0)).toBe(true);
  });

  it('does NOT re-insert an existing locked speaker (preserves locks)', async () => {
    const { deps, calls } = makeDeps({
      repo: {
        getTranscriptionStatus: () => 'recording',
        getSpeakers: () => [
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          {
            id: 9,
            noteId: 1,
            speakerLabel: 'speaker_0',
            displayName: 'Alice',
            speakerStatus: 'locked',
            speakerLocked: 1,
          } as any,
        ],
        replaceSegments: () => undefined,
        upsertSpeakers: (_id, rows) => {
          calls.speakers = rows;
        },
        updateSpeaker: () => undefined,
        setTranscriptionStatus: (_id, s) => calls.status.push(s),
      },
    });
    await processMeeting({ noteId: 1, wavUri: 'file://m.wav', expectedSpeakerCount: 2 }, deps);
    const spk = calls.speakers as Array<{ speakerLabel: string }>;
    expect(spk.map((s) => s.speakerLabel)).toEqual(['speaker_1']); // only the NEW speaker inserted
  });

  it('re-diarize from a terminal state: reads current status "done" and legally transitions done -> transcribing -> ... -> done', async () => {
    const { deps, calls } = makeDeps({
      repo: {
        getTranscriptionStatus: () => 'done',
        getSpeakers: () => [],
        replaceSegments: (_id, segs) => {
          calls.segments = segs;
          calls.seq.push('replaceSegments');
        },
        upsertSpeakers: (_id, rows) => {
          calls.speakers = rows;
          calls.seq.push('upsertSpeakers');
        },
        updateSpeaker: () => undefined,
        setTranscriptionStatus: (_id, s) => {
          calls.status.push(s);
          calls.seq.push(`status:${s}`);
        },
      },
    });
    await processMeeting({ noteId: 1, wavUri: 'file://m.wav', expectedSpeakerCount: 2 }, deps);
    expect(calls.status).toEqual(['transcribing', 'diarizing', 'done']); // done->transcribing is a legal re-run
  });

  it('fails (no silent empty meeting) when transcription returns no word segments', async () => {
    const { deps, calls } = makeDeps({
      transcribe: async () => ({ text: '', duration: 0, provider: 'local', segments: [] }),
    });
    await expect(processMeeting({ noteId: 1, wavUri: 'file://m.wav' }, deps)).rejects.toThrow(
      /word timestamps/,
    );
    expect(calls.status).toEqual(['transcribing', 'failed']);
    expect(calls.segments).toBeUndefined(); // never persisted an empty transcript
  });

  it('sets status failed, skips persistence, and rethrows when transcription throws', async () => {
    const { deps, calls } = makeDeps({
      transcribe: async () => {
        throw new Error('whisper boom');
      },
    });
    await expect(processMeeting({ noteId: 1, wavUri: 'file://m.wav' }, deps)).rejects.toThrow(
      'whisper boom',
    );
    expect(calls.status).toEqual(['transcribing', 'failed']);
    expect(calls.segments).toBeUndefined(); // no partial persistence on failure
    expect(calls.seq).toEqual(['status:transcribing', 'status:failed']);
  });
});

jest.mock('llama.rn', () => ({ initLlama: jest.fn() }));
jest.mock('expo-file-system/legacy', () => ({ documentDirectory: '/doc/' }));
jest.mock('../../../../modules/parakeet-asr/src', () => ({ ParakeetASR: {} }));
jest.mock('@/data', () => ({ notesRepository: {} }));
jest.mock('@/services/transcription/LocalWhisperService', () => ({ LocalWhisperService: {} }));
jest.mock('@/services/transcription/LocalParakeetService', () => ({ LocalParakeetService: {} }));

import {
  resultsForSharing,
  takeLinesWithinChars,
  thinkingLeaked,
  validateMeetingNotesJson,
  type QwenRunResult,
} from '@/lib/benchmark/runQwenBenchmark';

const validNotes = {
  summary: 'Agreed the Q4 roadmap.',
  keyDiscussionPoints: ['Incident review'],
  decisions: ['Ship workspaces first'],
  actionItems: [{ text: 'Draft the postmortem', owner: 'Marcus' }, { text: 'Update the roadmap' }],
  followUps: [],
};

describe('thinkingLeaked', () => {
  it('is false for a plain answer', () => {
    expect(thinkingLeaked({ text: 'Hello.', reasoning_content: '' })).toBe(false);
  });

  it('catches reasoning separated by the parser', () => {
    expect(thinkingLeaked({ text: 'Hello.', reasoning_content: 'Let me think' })).toBe(true);
  });

  it('catches a raw think tag left in the text', () => {
    expect(thinkingLeaked({ text: '<think>hmm</think>Hello.', reasoning_content: '' })).toBe(true);
  });
});

describe('validateMeetingNotesJson', () => {
  it('accepts notes with every required field', () => {
    expect(validateMeetingNotesJson(JSON.stringify(validNotes))).toEqual({ ok: true });
  });

  it('rejects text that is not JSON', () => {
    expect(validateMeetingNotesJson('Summary: things happened').ok).toBe(false);
  });

  it('rejects a missing array', () => {
    const notes: Partial<typeof validNotes> = { ...validNotes };
    delete notes.decisions;
    expect(validateMeetingNotesJson(JSON.stringify(notes))).toEqual({
      ok: false,
      error: 'decisions is not a string array',
    });
  });

  it('rejects an action item without text', () => {
    const notes = { ...validNotes, actionItems: [{ owner: 'Lena' }] };
    expect(validateMeetingNotesJson(JSON.stringify(notes))).toEqual({
      ok: false,
      error: 'actionItems is malformed',
    });
  });
});

describe('takeLinesWithinChars', () => {
  it('keeps whole lines up to the limit, counting the blank line between them', () => {
    expect(takeLinesWithinChars(['aaaa', 'bbbb', 'cccc'], 12)).toEqual(['aaaa', 'bbbb']);
  });

  it('returns nothing when the first line is already too long', () => {
    expect(takeLinesWithinChars(['a'.repeat(20)], 10)).toEqual([]);
  });
});

describe('resultsForSharing', () => {
  it('keeps measurements and drops model output', () => {
    const run: QwenRunResult = {
      config: { nCtx: 16384, gpu: true, startDelayMs: 0 },
      device: null,
      ok: true,
      startedAt: '2026-10-07T00:00:00.000Z',
      appStateAtStart: 'active',
      backgroundedDuringRun: false,
      peakBytes: 2_000_000_000,
      scenarios: [
        { name: 'meeting-notes', ok: true, output: 'private meeting content', totalMs: 1234 },
      ],
    };
    const shared = JSON.parse(resultsForSharing([run]));
    expect(shared[0].peakBytes).toBe(2_000_000_000);
    expect(shared[0].scenarios[0]).toEqual({ name: 'meeting-notes', ok: true, totalMs: 1234 });
  });
});

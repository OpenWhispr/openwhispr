jest.mock('llama.rn', () => ({ initLlama: jest.fn() }));
jest.mock('expo-file-system/legacy', () => ({ documentDirectory: '/doc/' }));
jest.mock('../../../../modules/parakeet-asr/src', () => ({ ParakeetASR: {} }));
jest.mock('@/data', () => ({ notesRepository: {} }));
jest.mock('@/services/transcription/LocalWhisperService', () => ({ LocalWhisperService: {} }));
jest.mock('@/services/transcription/LocalParakeetService', () => ({ LocalParakeetService: {} }));

import {
  pickModelFile,
  resultsForSharing,
  SPIKE_MODELS,
  takeLinesWithinChars,
  thinkingLeaked,
  validateMeetingNotesJson,
  type LlmRunResult,
} from '@/lib/benchmark/runLlmBenchmark';

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
    const run: LlmRunResult = {
      config: { modelId: 'qwen3.5-2b', nCtx: 16384, gpu: true, startDelayMs: 0 },
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

describe('pickModelFile', () => {
  const pattern = /Q4_K_M\.gguf$/i;

  it('takes the LFS size of the matching file, skipping other quants and the vision projector', () => {
    expect(
      pickModelFile(
        [
          { type: 'file', path: 'README.md', size: 4000 },
          {
            type: 'file',
            path: 'mmproj-Qwen_Qwen3.5-2B-f16.gguf',
            size: 9,
            lfs: { size: 668_000_000 },
          },
          {
            type: 'file',
            path: 'Qwen_Qwen3.5-2B-Q8_0.gguf',
            size: 9,
            lfs: { size: 2_200_000_000 },
          },
          {
            type: 'file',
            path: 'Qwen_Qwen3.5-2B-Q4_K_M.gguf',
            size: 9,
            lfs: { size: 1_300_000_000 },
          },
        ],
        pattern,
      ),
    ).toEqual({ path: 'Qwen_Qwen3.5-2B-Q4_K_M.gguf', size: 1_300_000_000 });
  });

  it('matches whatever case the uploader used', () => {
    expect(
      pickModelFile(
        [{ type: 'file', path: 'minicpm5-2b-q4_k_m.gguf', size: 1_560_000_000 }],
        pattern,
      ),
    ).toEqual({ path: 'minicpm5-2b-q4_k_m.gguf', size: 1_560_000_000 });
  });

  it('returns null when the repo has no such file', () => {
    expect(pickModelFile([{ type: 'directory', path: 'Q4_K_M.gguf' }], pattern)).toBeNull();
  });
});

describe('SPIKE_MODELS', () => {
  it('has unique ids', () => {
    const ids = SPIKE_MODELS.map((model) => model.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

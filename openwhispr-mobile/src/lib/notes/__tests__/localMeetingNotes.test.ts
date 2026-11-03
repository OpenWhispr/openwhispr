import { Platform } from 'react-native';
jest.mock('@/lib/appleLLM', () => ({
  AppleLLM: {
    generateMeetingNotes: jest.fn(),
  },
}));

jest.mock('@/android/LocalTextModel', () => ({ LocalTextModel: { processText: jest.fn() } }));

jest.mock('@/data', () => ({
  notesRepository: {
    getNoteById: jest.fn(),
    getSegments: jest.fn(),
    getSpeakers: jest.fn(),
    getActions: jest.fn(),
  },
}));

jest.mock('@/lib/localReasoning', () => ({
  LOCAL_OUTPUT_TOKEN_RESERVE: 900,
  countLocalInputTokens: jest.fn(async () => 700),
  fitsLocalReasoningBudget: jest.fn(async () => true),
  getLocalInputTokenBudget: jest.fn(() => 2896),
  getLocalReasoningReadiness: jest.fn(async () => ({
    status: 'ready',
    contextSize: 4096,
    tokenCounting: true,
  })),
  isLocalContextLimitError: (error: unknown) =>
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    ['APPLE_LLM_CONTEXT_LIMIT', 'LOCAL_CONTEXT_LIMIT'].includes(
      String((error as { code?: unknown }).code),
    ),
  isLocalOutputLimitError: (error: unknown) =>
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'APPLE_LLM_OUTPUT_LIMIT',
  toLocalReasoningError: (error: unknown) => error,
}));

import {
  generateLocalMeetingNotes,
  renderStructuredMeetingNotesToMarkdown,
} from '../localMeetingNotes';
import { LocalTextModel } from '@/android/LocalTextModel';
import { AppleLLM } from '@/lib/appleLLM';
import { notesRepository } from '@/data';
import {
  countLocalInputTokens,
  fitsLocalReasoningBudget,
  getLocalInputTokenBudget,
} from '@/lib/localReasoning';

const mockGenerateMeetingNotes = AppleLLM.generateMeetingNotes as jest.Mock;
const mockGetNoteById = notesRepository.getNoteById as jest.Mock;
const mockGetSegments = notesRepository.getSegments as jest.Mock;
const mockGetSpeakers = notesRepository.getSpeakers as jest.Mock;
const mockGetActions = notesRepository.getActions as jest.Mock;
const mockFitsBudget = fitsLocalReasoningBudget as jest.Mock;
const mockGetInputBudget = getLocalInputTokenBudget as jest.Mock;
const mockCountInputTokens = countLocalInputTokens as jest.Mock;

const outputLimit = (): Error =>
  Object.assign(new Error('decodingFailure'), { code: 'APPLE_LLM_OUTPUT_LIMIT' });

const partialNotes = (summary: string, decisions: string[] = []) => ({
  summary,
  keyDiscussionPoints: [],
  decisions,
  actionItems: [],
  followUps: [],
});

const segmentsOf = (count: number) =>
  Array.from({ length: count }, (_, index) => ({
    id: 100 + index,
    noteId: 7,
    startMs: index * 60_000,
    endMs: index * 60_000 + 2000,
    text: `Line ${index} about the launch plan.`,
    // Alternating speakers, since one speaker's consecutive segments read as one line.
    speakerLabel: `speaker_${index % 2}`,
    sortOrder: index,
  }));

const meetingNote = {
  id: 7,
  title: 'Planning',
  content: '',
  noteType: 'meeting',
  calendarEventId: null,
  participants: null,
  deletedAt: null,
};

const speaker = {
  id: 10,
  noteId: 7,
  speakerLabel: 'speaker_0',
  displayName: null,
  sortOrder: 0,
  speakerStatus: 'provisional',
  color: null,
};

beforeEach(() => {
  jest.clearAllMocks();
  mockGenerateMeetingNotes.mockReset();
  mockFitsBudget.mockResolvedValue(true);
  mockGetInputBudget.mockReturnValue(2896);
  mockCountInputTokens.mockResolvedValue(700);
  mockGetNoteById.mockReturnValue(meetingNote);
  mockGetSegments.mockReturnValue([
    {
      id: 20,
      noteId: 7,
      startMs: 0,
      endMs: 2000,
      text: 'We need to ship the onboarding fix before launch and confirm Alice owns the checklist.',
      speakerLabel: 'speaker_0',
      sortOrder: 0,
    },
  ]);
  mockGetSpeakers.mockReturnValue([speaker]);
  mockGetActions.mockReturnValue([]);
});

describe('local meeting notes', () => {
  it('renders structured notes to markdown sections', () => {
    expect(
      renderStructuredMeetingNotesToMarkdown({
        summary: 'The team reviewed launch readiness.',
        keyDiscussionPoints: ['Onboarding is the main launch risk.'],
        decisions: ['Ship the onboarding fix first.'],
        actionItems: [{ text: 'Confirm the launch checklist.', owner: 'Alice' }],
        followUps: ['Review progress next week.'],
      }),
    ).toBe(
      [
        'The team reviewed launch readiness.',
        '## Key Discussion Points\n- Onboarding is the main launch risk.',
        '## Decisions Made\n- Ship the onboarding fix first.',
        '## Action Items\n- [ ] Alice: Confirm the launch checklist.',
        '## Follow-ups\n- Review progress next week.',
      ].join('\n\n'),
    );
  });

  it('splits and retries a chunk on local context-limit errors', async () => {
    mockGenerateMeetingNotes
      .mockRejectedValueOnce(
        Object.assign(new Error('too large'), { code: 'APPLE_LLM_CONTEXT_LIMIT' }),
      )
      .mockResolvedValueOnce({
        summary: 'First half',
        keyDiscussionPoints: ['Onboarding fix discussed.'],
        decisions: [],
        actionItems: [],
        followUps: [],
      })
      .mockResolvedValueOnce({
        summary: 'Second half',
        keyDiscussionPoints: [],
        decisions: ['Alice owns the checklist.'],
        actionItems: [{ text: 'Confirm the checklist.', owner: 'Alice' }],
        followUps: [],
      })
      .mockResolvedValueOnce({
        summary: 'Merged summary',
        keyDiscussionPoints: ['Onboarding fix discussed.'],
        decisions: ['Alice owns the checklist.'],
        actionItems: [{ text: 'Confirm the checklist.', owner: 'Alice' }],
        followUps: [],
      });

    await expect(generateLocalMeetingNotes(7)).resolves.toContain('Merged summary');
    expect(mockGenerateMeetingNotes).toHaveBeenCalledTimes(4);
    expect(mockGenerateMeetingNotes.mock.calls[1][0].prompt).toContain('[0:00] Speaker 1:');
    expect(mockGenerateMeetingNotes.mock.calls[2][0].prompt).toContain(
      'Previous chunk summary for continuity:\nFirst half',
    );
  });

  it('omits unknown speaker labels from local meeting-note prompts', async () => {
    mockGetSegments.mockReturnValue([
      {
        id: 20,
        noteId: 7,
        startMs: 0,
        endMs: 2000,
        text: 'Ship the onboarding fix.',
        speakerLabel: null,
        sortOrder: 0,
      },
    ]);
    mockGetSpeakers.mockReturnValue([]);
    mockGenerateMeetingNotes.mockResolvedValue({
      summary: 'The onboarding fix needs to ship.',
      keyDiscussionPoints: [],
      decisions: [],
      actionItems: [{ text: 'Ship the onboarding fix.', owner: null }],
      followUps: [],
    });

    await generateLocalMeetingNotes(7);

    expect(mockGenerateMeetingNotes.mock.calls[0][0].prompt).toContain(
      'Meeting transcript:\n[0:00] Ship the onboarding fix.',
    );
    expect(mockGenerateMeetingNotes.mock.calls[0][0].prompt).not.toContain('Unknown speaker');
  });

  // Guided generation cut off by the output cap can't be decoded (FoundationModels'
  // decodingFailure), which the native module reports as APPLE_LLM_OUTPUT_LIMIT.
  it('halves a chunk whose notes run past the output cap and retries it', async () => {
    mockGetSegments.mockReturnValue(segmentsOf(2));
    mockGenerateMeetingNotes
      .mockRejectedValueOnce(outputLimit())
      .mockResolvedValueOnce(partialNotes('First half'))
      .mockResolvedValueOnce(partialNotes('Second half'))
      .mockResolvedValueOnce(partialNotes('Merged summary'));

    await expect(generateLocalMeetingNotes(7)).resolves.toContain('Merged summary');
    expect(mockGenerateMeetingNotes).toHaveBeenCalledTimes(4);
    expect(mockGenerateMeetingNotes.mock.calls[1][0].prompt).toContain('Line 0');
    expect(mockGenerateMeetingNotes.mock.calls[1][0].prompt).not.toContain('Line 1');
    expect(mockGenerateMeetingNotes.mock.calls[2][0].prompt).toContain('Line 1');
  });

  it('does not split one line by words when its notes run past the output cap', async () => {
    mockGenerateMeetingNotes.mockRejectedValue(outputLimit());

    await expect(generateLocalMeetingNotes(7)).rejects.toMatchObject({
      code: 'APPLE_LLM_OUTPUT_LIMIT',
    });
    expect(mockGenerateMeetingNotes).toHaveBeenCalledTimes(1);
  });

  it('stops halving a chunk whose notes keep running past the output cap', async () => {
    mockGetSegments.mockReturnValue(segmentsOf(8));
    mockGenerateMeetingNotes.mockRejectedValue(outputLimit());

    await expect(generateLocalMeetingNotes(7)).rejects.toMatchObject({
      code: 'APPLE_LLM_OUTPUT_LIMIT',
    });
    // The chunk, its first half, then that half's first quarter, which ends the note.
    expect(mockGenerateMeetingNotes).toHaveBeenCalledTimes(3);
  });

  it('merges partial notes by hand when the merged notes run past the output cap', async () => {
    mockGetSegments.mockReturnValue(segmentsOf(2));
    mockFitsBudget.mockImplementation(
      async ({ prompt }: { prompt: string }) =>
        // One line per chunk, so the transcript maps in two runs; the merge prompt fits.
        prompt.includes('Merge these') || !(prompt.includes('Line 0') && prompt.includes('Line 1')),
    );
    mockGenerateMeetingNotes
      .mockResolvedValueOnce(partialNotes('First chunk.', ['Ship Friday.']))
      .mockResolvedValueOnce(partialNotes('Second chunk.', ['Alice owns QA.']))
      .mockRejectedValueOnce(outputLimit());

    const markdown = await generateLocalMeetingNotes(7);

    expect(mockGenerateMeetingNotes).toHaveBeenCalledTimes(3);
    expect(markdown).toContain('First chunk. Second chunk.');
    expect(markdown).toContain('- Ship Friday.\n- Alice owns QA.');
  });

  it.each([
    [2896, 2896],
    [6992, 2896],
  ])("caps a merge at iOS 26's input budget (budget %i)", async (inputBudget, mergeBudget) => {
    mockGetInputBudget.mockReturnValue(inputBudget);
    mockGetSegments.mockReturnValue(segmentsOf(2));
    mockFitsBudget.mockImplementation(
      async ({ prompt }: { prompt: string }) =>
        prompt.includes('Merge these') || !(prompt.includes('Line 0') && prompt.includes('Line 1')),
    );
    mockGenerateMeetingNotes.mockResolvedValue(partialNotes('Notes'));

    await generateLocalMeetingNotes(7);

    expect(mockFitsBudget).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: expect.stringContaining('Merge these'),
        budget: mergeBudget,
      }),
    );
  });

  it.each([
    // The default instructions leave a chunk of about 2,000 tokens, whatever the context.
    [2896, 700, 2000],
    [6992, 700, 2000],
    // Long raw notes repeat in every chunk, so they don't take the transcript's room.
    [6992, 1600, 2900],
    // The input budget still caps a chunk.
    [2896, 2000, 2896],
  ])(
    'limits each chunk to the transcript the output cap allows (budget %i, overhead %i)',
    async (inputBudget, overhead, chunkBudget) => {
      mockGetInputBudget.mockReturnValue(inputBudget);
      mockCountInputTokens.mockResolvedValue(overhead);
      mockGenerateMeetingNotes.mockResolvedValue(partialNotes('Notes'));

      await generateLocalMeetingNotes(7);

      expect(mockCountInputTokens).toHaveBeenCalledWith({
        instructions: expect.any(String),
        prompt: '',
      });
      expect(mockFitsBudget).toHaveBeenCalledWith(expect.objectContaining({ budget: chunkBudget }));
    },
  );

  it('keeps lines whole when the instructions and raw notes alone fill a chunk', async () => {
    mockGetSegments.mockReturnValue([
      { ...segmentsOf(1)[0], text: Array.from({ length: 40 }, (_, i) => `w${i}`).join(' ') },
    ]);
    mockCountInputTokens.mockResolvedValue(3000);
    mockFitsBudget.mockResolvedValue(false);
    mockGenerateMeetingNotes.mockResolvedValue(partialNotes('Notes'));

    await generateLocalMeetingNotes(7);

    expect(mockGenerateMeetingNotes).toHaveBeenCalledTimes(1);
    expect(mockGenerateMeetingNotes.mock.calls[0][0].prompt).toContain('w0 w1');
  });

  // One speaker's consecutive segments are one line, so a long monologue is a single line.
  it('splits one line too long for a chunk by words', async () => {
    const words = Array.from({ length: 40 }, (_, index) => `w${index}`);
    mockGetSegments.mockReturnValue([{ ...segmentsOf(1)[0], text: words.join(' ') }]);
    const wordsIn = (prompt: string): string[] => prompt.match(/\bw\d+\b/g) ?? [];
    mockFitsBudget.mockImplementation(
      async ({ prompt }: { prompt: string }) => wordsIn(prompt).length <= 10,
    );
    mockGenerateMeetingNotes.mockResolvedValue(partialNotes('Notes'));

    await generateLocalMeetingNotes(7);

    const mapPrompts = mockGenerateMeetingNotes.mock.calls
      .map(([request]) => request.prompt as string)
      .filter((prompt) => !prompt.includes('Merge these'));
    expect(mapPrompts).toHaveLength(4);
    expect(mapPrompts.flatMap(wordsIn)).toEqual(words);
  });
});

describe('Android local meeting formatting', () => {
  const result = {
    summary: 'The team planned the launch.',
    keyDiscussionPoints: [],
    decisions: [],
    actionItems: [{ text: 'Confirm the checklist.', owner: 'Alice' }],
    followUps: [],
  };
  it('uses the downloaded Android engine for meeting notes without calling Apple', async () => {
    const original = Platform.OS;
    Platform.OS = 'android';
    (LocalTextModel.processText as jest.Mock).mockResolvedValue({ text: JSON.stringify(result) });
    try {
      const text = await generateLocalMeetingNotes(7);
      expect(text).toContain('Alice: Confirm the checklist.');
      expect(LocalTextModel.processText).toHaveBeenCalledWith(
        expect.objectContaining({
          systemPrompt: expect.stringContaining('Return only a JSON object'),
        }),
      );
      expect((LocalTextModel.processText as jest.Mock).mock.calls[0][0].systemPrompt).not.toContain(
        'notes in markdown',
      );
      expect(mockGenerateMeetingNotes).not.toHaveBeenCalled();
    } finally {
      Platform.OS = original;
    }
  });
  it('splits an oversized Android transcript line and merges the smaller results', async () => {
    const original = Platform.OS;
    Platform.OS = 'android';
    const generate = LocalTextModel.processText as jest.Mock;
    generate
      .mockRejectedValueOnce(
        Object.assign(new Error('Context is full'), { code: 'LOCAL_CONTEXT_LIMIT' }),
      )
      .mockResolvedValue({ text: JSON.stringify(result) });
    try {
      await expect(generateLocalMeetingNotes(7)).resolves.toContain('Confirm the checklist.');
      expect(generate).toHaveBeenCalledTimes(4);
      expect(generate.mock.calls[1][0].text).not.toBe(generate.mock.calls[2][0].text);
      expect(mockGenerateMeetingNotes).not.toHaveBeenCalled();
    } finally {
      Platform.OS = original;
    }
  });
  it('rejects malformed Android output without calling Apple or saving invented notes', async () => {
    const original = Platform.OS;
    Platform.OS = 'android';
    (LocalTextModel.processText as jest.Mock).mockResolvedValue({ text: '{"summary": 42}' });
    try {
      await expect(generateLocalMeetingNotes(7)).rejects.toThrow();
      expect(mockGenerateMeetingNotes).not.toHaveBeenCalled();
    } finally {
      Platform.OS = original;
    }
  });
});

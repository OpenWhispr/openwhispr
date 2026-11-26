import { Platform } from 'react-native';
jest.mock('@/lib/appleLLM', () => ({
  AppleLLM: {
    generateMeetingNotes: jest.fn(),
  },
}));
jest.mock('@/android/shared/lib/appleLLM', () => jest.requireMock('@/lib/appleLLM'));

jest.mock('@/android/LocalTextModel', () => ({ LocalTextModel: { processText: jest.fn() } }));

jest.mock('@/data', () => ({
  notesRepository: {
    getNoteById: jest.fn(),
    getSegments: jest.fn(),
    getSpeakers: jest.fn(),
    getActions: jest.fn(),
  },
}));
jest.mock('@/android/shared/data', () => jest.requireMock('@/data'));

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
  toLocalReasoningError: jest.fn((error: unknown) => error),
}));
jest.mock('@/android/shared/lib/localReasoning', () => jest.requireMock('@/lib/localReasoning'));

import {
  generateLocalMeetingNotes,
  renderStructuredMeetingNotesToMarkdown,
} from '@/android/lib/notes/localMeetingNotes';
import { LocalTextModel } from '@/android/LocalTextModel';
import { AppleLLM } from '@/lib/appleLLM';
import { notesRepository } from '@/data';
import {
  countLocalInputTokens,
  fitsLocalReasoningBudget,
  getLocalInputTokenBudget,
  toLocalReasoningError,
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

  it('splits a native output-limited chunk and retains both halves in the merge', async () => {
    const original = Platform.OS;
    Platform.OS = 'android';
    mockGetSegments.mockReturnValue(segmentsOf(2));
    const generate = LocalTextModel.processText as jest.Mock;
    generate
      .mockReset()
      .mockRejectedValueOnce(Object.assign(new Error('Output cap'), { code: 'LOCAL_OUTPUT_LIMIT' }))
      .mockResolvedValueOnce({ text: JSON.stringify(partialNotes('First half')) })
      .mockResolvedValueOnce({ text: JSON.stringify(partialNotes('Second half')) })
      .mockResolvedValueOnce({ text: JSON.stringify(partialNotes('Combined notes')) });
    try {
      await expect(generateLocalMeetingNotes(7)).resolves.toBe('Combined notes');
      expect(generate).toHaveBeenCalledTimes(4);
      expect(generate.mock.calls[1][0].text).toContain('Line 0');
      expect(generate.mock.calls[1][0].text).not.toContain('Line 1');
      expect(generate.mock.calls[2][0].text).toContain('Line 1');
      expect(generate.mock.calls[3][0].text).toContain('First half');
      expect(generate.mock.calls[3][0].text).toContain('Second half');
      expect(mockGenerateMeetingNotes).not.toHaveBeenCalled();
    } finally {
      Platform.OS = original;
    }
  });

  it('bounds repeated native output-limit splitting', async () => {
    const original = Platform.OS;
    Platform.OS = 'android';
    const failure = Object.assign(new Error('Output cap'), { code: 'LOCAL_OUTPUT_LIMIT' });
    mockGetSegments.mockReturnValue(segmentsOf(8));
    const generate = (LocalTextModel.processText as jest.Mock)
      .mockReset()
      .mockRejectedValue(failure);
    try {
      await expect(generateLocalMeetingNotes(7)).rejects.toBe(failure);
      expect(generate).toHaveBeenCalledTimes(3);
    } finally {
      Platform.OS = original;
    }
  });

  it('preserves an unsplittable native output-limit error before generic normalization', async () => {
    const original = Platform.OS;
    Platform.OS = 'android';
    const failure = Object.assign(new Error('Output cap'), { code: 'LOCAL_OUTPUT_LIMIT' });
    const normalize = toLocalReasoningError as jest.Mock;
    normalize.mockImplementation(() =>
      Object.assign(new Error('Normalized'), { code: 'LOCAL_REASONING_FAILED' }),
    );
    const generate = (LocalTextModel.processText as jest.Mock)
      .mockReset()
      .mockRejectedValue(failure);
    try {
      await expect(generateLocalMeetingNotes(7)).rejects.toBe(failure);
      expect(generate).toHaveBeenCalledTimes(1);
      expect(normalize).not.toHaveBeenCalled();
    } finally {
      normalize.mockImplementation((error: unknown) => error);
      Platform.OS = original;
    }
  });

  it('keeps the completed chunks when native output limits prevent the merge', async () => {
    const original = Platform.OS;
    Platform.OS = 'android';
    mockGetSegments.mockReturnValue(segmentsOf(2));
    mockFitsBudget.mockImplementation(
      async ({ prompt }: { prompt: string }) =>
        prompt.includes('Merge these') || !(prompt.includes('Line 0') && prompt.includes('Line 1')),
    );
    const generate = (LocalTextModel.processText as jest.Mock)
      .mockReset()
      .mockResolvedValueOnce({
        text: JSON.stringify(partialNotes('First chunk.', ['Ship Friday.'])),
      })
      .mockResolvedValueOnce({
        text: JSON.stringify(partialNotes('Second chunk.', ['Alice owns QA.'])),
      })
      .mockRejectedValueOnce(
        Object.assign(new Error('Output cap'), { code: 'LOCAL_OUTPUT_LIMIT' }),
      );
    try {
      const markdown = await generateLocalMeetingNotes(7);
      expect(generate).toHaveBeenCalledTimes(3);
      expect(markdown).toContain('First chunk. Second chunk.');
      expect(markdown).toContain('- Ship Friday.\n- Alice owns QA.');
    } finally {
      Platform.OS = original;
    }
  });

  it('honors cancellation before retrying a native output-limited chunk', async () => {
    const original = Platform.OS;
    Platform.OS = 'android';
    mockGetSegments.mockReturnValue(segmentsOf(2));
    let cancelled = false;
    const abort = new Error('Meeting cancelled');
    const generate = (LocalTextModel.processText as jest.Mock)
      .mockReset()
      .mockImplementation(async () => {
        cancelled = true;
        throw Object.assign(new Error('Output cap'), { code: 'LOCAL_OUTPUT_LIMIT' });
      });
    try {
      await expect(
        generateLocalMeetingNotes(7, {
          checkpoint: () => {
            if (cancelled) throw abort;
          },
        }),
      ).rejects.toBe(abort);
      expect(generate).toHaveBeenCalledTimes(1);
    } finally {
      Platform.OS = original;
    }
  });

  it('honors cancellation while checking the merge budget before starting generation', async () => {
    const original = Platform.OS;
    Platform.OS = 'android';
    mockGetSegments.mockReturnValue(segmentsOf(2));
    let cancelled = false;
    const abort = new Error('Meeting cancelled');
    mockFitsBudget.mockImplementation(async ({ prompt }: { prompt: string }) => {
      if (prompt.includes('Merge these')) {
        cancelled = true;
        return true;
      }
      return !(prompt.includes('Line 0') && prompt.includes('Line 1'));
    });
    const generate = (LocalTextModel.processText as jest.Mock)
      .mockReset()
      .mockResolvedValue({ text: JSON.stringify(partialNotes('A completed chunk')) });
    try {
      await expect(
        generateLocalMeetingNotes(7, {
          checkpoint: () => {
            if (cancelled) throw abort;
          },
        }),
      ).rejects.toBe(abort);
      expect(generate).toHaveBeenCalledTimes(2);
    } finally {
      Platform.OS = original;
    }
  });
});

jest.mock('@/lib/notes/generateNotesPrompt', () => ({
  ...jest.requireActual<typeof import('@/lib/notes/generateNotesPrompt')>(
    '@/lib/notes/generateNotesPrompt',
  ),
  buildActionSystemPrompt: (
    input: Parameters<
      (typeof import('@/lib/notes/generateNotesPrompt.android'))['buildActionSystemPrompt']
    >[0],
  ) => {
    const os = jest.requireActual<typeof import('react-native')>('react-native').Platform.OS;
    return os === 'android'
      ? jest
          .requireActual<
            typeof import('@/lib/notes/generateNotesPrompt.android')
          >('@/lib/notes/generateNotesPrompt.android')
          .buildActionSystemPrompt(input)
      : jest
          .requireActual<
            typeof import('@/lib/notes/generateNotesPrompt')
          >('@/lib/notes/generateNotesPrompt')
          .buildActionSystemPrompt(input);
  },
}));

jest.mock('@/android/lib/notes/localMeetingNotesPlatform', () => {
  const selected =
    (): (typeof import('@/android/lib/notes/localMeetingNotesPlatform'))['localMeetingNotesPlatform'] => {
      const os = jest.requireActual<typeof import('react-native')>('react-native').Platform.OS;
      return os === 'android'
        ? jest.requireActual<typeof import('@/android/lib/notes/localMeetingNotesPlatform')>(
            '@/android/lib/notes/localMeetingNotesPlatform',
          ).localMeetingNotesPlatform
        : jest.requireActual<typeof import('@/android/lib/notes/localMeetingNotesPlatform')>(
            '@/android/lib/notes/localMeetingNotesPlatform',
          ).localMeetingNotesPlatform;
    };
  return {
    localMeetingNotesPlatform: {
      get modelName() {
        return selected().modelName;
      },
      buildInstructions: (actionPrompt: string) => selected().buildInstructions(actionPrompt),
      generateNotes: (input: { instructions: string; prompt: string }) =>
        selected().generateNotes(input),
      getCheckpoint: (options: { checkpoint?: () => void }) => selected().getCheckpoint(options),
      isOutputLimitError: (error: unknown) => selected().isOutputLimitError?.(error) ?? false,
    },
  };
});

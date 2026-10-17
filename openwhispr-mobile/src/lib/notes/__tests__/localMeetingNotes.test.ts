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
  fitsLocalReasoningBudget: jest.fn(async () => true),
  getLocalInputTokenBudget: () => 2896,
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
  toLocalReasoningError: (error: unknown) => error,
}));

import {
  generateLocalMeetingNotes,
  renderStructuredMeetingNotesToMarkdown,
} from '../localMeetingNotes';
import { LocalTextModel } from '@/android/LocalTextModel';
import { AppleLLM } from '@/lib/appleLLM';
import { notesRepository } from '@/data';

const mockGenerateMeetingNotes = AppleLLM.generateMeetingNotes as jest.Mock;
const mockGetNoteById = notesRepository.getNoteById as jest.Mock;
const mockGetSegments = notesRepository.getSegments as jest.Mock;
const mockGetSpeakers = notesRepository.getSpeakers as jest.Mock;
const mockGetActions = notesRepository.getActions as jest.Mock;

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

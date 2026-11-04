import { Platform } from 'react-native';

jest.mock('@/lib/appleLLM', () => ({ AppleLLM: { generateMeetingNotes: jest.fn() } }));
jest.mock('@/android/LocalTextModel', () => ({ LocalTextModel: { processText: jest.fn() } }));
jest.mock('@/data', () => ({
  notesRepository: {
    getNoteById: jest.fn(),
    getSegments: jest.fn(),
    getSpeakers: jest.fn(() => []),
    getActions: jest.fn(() => []),
  },
}));
// Load both real platform entries before installing the budget stubs so the Android
// adapter's explicit default-module import retains the real upstream implementation.
const iosReasoning: typeof import('@/lib/localReasoning') =
  jest.requireActual('@/lib/localReasoning');
const androidReasoning: typeof import('@/lib/localReasoning.android') = jest.requireActual(
  '@/lib/localReasoning.android',
);
jest.doMock('@/lib/localReasoning', () => ({
  ...iosReasoning,
  toLocalReasoningError: (error: unknown) =>
    (Platform.OS === 'android' ? androidReasoning : iosReasoning).toLocalReasoningError(error),
  countLocalInputTokens: jest.fn(async () => 700),
  fitsLocalReasoningBudget: jest.fn(async () => true),
  getLocalReasoningReadiness: jest.fn(async () => ({
    status: 'ready',
    contextSize: 4096,
    tokenCounting: true,
  })),
}));
jest.doMock('@/lib/notes/localMeetingNotesPlatform', () => {
  const selected =
    (): (typeof import('@/lib/notes/localMeetingNotesPlatform'))['localMeetingNotesPlatform'] =>
      Platform.OS === 'android'
        ? jest.requireActual<typeof import('@/lib/notes/localMeetingNotesPlatform.android')>(
            '@/lib/notes/localMeetingNotesPlatform.android',
          ).localMeetingNotesPlatform
        : jest.requireActual<typeof import('@/lib/notes/localMeetingNotesPlatform')>(
            '@/lib/notes/localMeetingNotesPlatform',
          ).localMeetingNotesPlatform;
  return {
    localMeetingNotesPlatform: {
      get modelName() {
        return selected().modelName;
      },
      buildInstructions: (actionPrompt: string) => selected().buildInstructions(actionPrompt),
      generateNotes: (input: { instructions: string; prompt: string }) =>
        selected().generateNotes(input),
      getCheckpoint: (options: { checkpoint?: () => void }) => selected().getCheckpoint(options),
    },
  };
});

import { AppleLLM } from '@/lib/appleLLM';
import { LocalTextModel } from '@/android/LocalTextModel';
import { notesRepository } from '@/data';
const {
  fitsLocalReasoningBudget,
}: typeof import('@/lib/localReasoning') = require('@/lib/localReasoning');
const {
  generateLocalMeetingNotes,
}: typeof import('@/lib/notes/localMeetingNotes') = require('@/lib/notes/localMeetingNotes');

const originalPlatform = Platform.OS;
const apple = jest.mocked(AppleLLM.generateMeetingNotes);
const android = jest.mocked(LocalTextModel.processText);
const fits = jest.mocked(fitsLocalReasoningBudget);
const partial = (summary: string) => ({
  summary,
  keyDiscussionPoints: [],
  decisions: [],
  actionItems: [],
  followUps: [],
});
const limited = (code: string) => Object.assign(new Error('Too long'), { code, retryable: false });
const syncFields = {
  remoteId: null,
  deletedAt: null,
  pendingSync: 0,
  createdAt: null,
  updatedAt: null,
};
const segments = (count: number) =>
  Array.from({ length: count }, (_, index) => ({
    ...syncFields,
    id: index + 1,
    noteId: 7,
    startMs: index * 60_000,
    endMs: index * 60_000 + 1000,
    text: `Line ${index} about the launch plan.`,
    speakerLabel: `speaker_${index % 2}`,
    sortOrder: index,
    clientId: null,
  }));

beforeEach(() => {
  jest.clearAllMocks();
  apple.mockReset();
  android.mockReset();
  fits.mockReset().mockResolvedValue(true);
  jest.mocked(notesRepository.getNoteById).mockReturnValue({
    ...syncFields,
    id: 7,
    title: 'Planning',
    content: '',
    noteType: 'meeting',
    calendarEventId: null,
    participants: null,
    folderId: null,
    sourceFile: null,
    audioDurationSeconds: null,
    enhancedContent: null,
    enhancementPrompt: null,
    enhancedAtContentHash: null,
    transcript: null,
    diarizationEnabled: 0,
    expectedSpeakerCount: null,
    transcriptionStatus: 'complete',
    clientNoteId: null,
    isPrivate: 0,
    spaceId: null,
    ownerUserId: null,
    updatedByUserId: null,
    cloudUpdatedAt: null,
    conflictServerNote: null,
    leftTeam: 0,
  });
  jest.mocked(notesRepository.getSegments).mockReturnValue(segments(2));
  jest.mocked(notesRepository.getSpeakers).mockReturnValue(
    [0, 1].map((index) => ({
      ...syncFields,
      id: index + 10,
      noteId: 7,
      speakerLabel: `speaker_${index}`,
      displayName: null,
      sortOrder: index,
      speakerStatus: 'provisional',
      color: null,
      profileId: null,
      speakerLocked: 0,
      speakerLockSource: null,
      clientId: null,
    })),
  );
});

afterEach(() => {
  Platform.OS = originalPlatform;
});

describe('iOS recovery isolation', () => {
  beforeEach(() => {
    Platform.OS = 'ios';
  });

  it('keeps Android checkpoints out of upstream Apple split and merge recovery', async () => {
    const events: string[] = [];
    apple.mockImplementation(async () => {
      events.push('generate');
      if (apple.mock.calls.length === 1) throw limited('APPLE_LLM_OUTPUT_LIMIT');
      return partial('Supported notes');
    });
    const text = await generateLocalMeetingNotes(7, { checkpoint: () => events.push('check') });
    expect(text).toBe('Supported notes');
    expect(events).toEqual(['generate', 'generate', 'generate', 'generate']);
    expect(android).not.toHaveBeenCalled();
  });

  it('preserves upstream Apple recovery when an Android checkpoint would cancel', async () => {
    let cancelled = false;
    apple.mockImplementation(async () => {
      if (apple.mock.calls.length === 1) {
        cancelled = true;
        throw limited('APPLE_LLM_OUTPUT_LIMIT');
      }
      return partial('Supported notes');
    });
    const checkpoint = jest.fn(() => {
      if (cancelled) throw Object.assign(new Error('Cancelled'), { name: 'AbortError' });
    });
    await expect(generateLocalMeetingNotes(7, { checkpoint })).resolves.toBe('Supported notes');
    expect(checkpoint).not.toHaveBeenCalled();
    expect(apple).toHaveBeenCalledTimes(4);
    expect(android).not.toHaveBeenCalled();
  });

  it('does not treat an Android-only output code as an Apple recovery trigger', async () => {
    apple.mockRejectedValue(limited('LOCAL_OUTPUT_LIMIT'));
    await expect(generateLocalMeetingNotes(7)).rejects.toMatchObject({
      code: 'APPLE_LLM_FAILED',
    });
    expect(apple).toHaveBeenCalledTimes(1);
  });
});

describe('Android bounded meeting recovery', () => {
  beforeEach(() => {
    Platform.OS = 'android';
  });

  it('retains both source halves when map and merge hit the native output limit', async () => {
    android
      .mockRejectedValueOnce(limited('LOCAL_OUTPUT_LIMIT'))
      .mockResolvedValueOnce({ text: JSON.stringify(partial('First half')), model: 'local' })
      .mockResolvedValueOnce({ text: JSON.stringify(partial('Second half')), model: 'local' })
      .mockRejectedValueOnce(limited('LOCAL_OUTPUT_LIMIT'));
    await expect(generateLocalMeetingNotes(7)).resolves.toBe('First half Second half');
    expect(android).toHaveBeenCalledTimes(4);
    expect(android.mock.calls[1][0].text).toContain('Line 0');
    expect(android.mock.calls[1][0].text).not.toContain('Line 1');
    expect(android.mock.calls[2][0].text).toContain('Line 1');
    expect(android.mock.calls[2][0].text).not.toContain('Line 0');
    expect(apple).not.toHaveBeenCalled();
  });

  it.each([
    [1, 1],
    [8, 3],
  ])('bounds recovery for %i transcript lines', async (lines, calls) => {
    jest.mocked(notesRepository.getSegments).mockReturnValue(segments(lines));
    android.mockRejectedValue(limited('LOCAL_OUTPUT_LIMIT'));
    await expect(generateLocalMeetingNotes(7)).rejects.toMatchObject({
      code: 'LOCAL_OUTPUT_LIMIT',
    });
    expect(android).toHaveBeenCalledTimes(calls);
    expect(apple).not.toHaveBeenCalled();
  });

  it.each(['first-limit', 'left-half', 'merge-limit', 'merge-budget'] as const)(
    'starts no more Android generations after cancellation during %s',
    async (stage) => {
      const reduce = stage.startsWith('merge-');
      jest.mocked(notesRepository.getSegments).mockReturnValue(segments(reduce ? 4 : 2));
      let cancelled = false;
      if (reduce)
        fits.mockImplementation(async ({ prompt }) => {
          if (prompt.startsWith('Merge these')) {
            if (stage === 'merge-budget') cancelled = true;
            return true;
          }
          return (prompt.match(/Line \d about/g) ?? []).length <= 1;
        });
      android.mockImplementation(async ({ text }) => {
        if (text.startsWith('Merge these') || (!reduce && android.mock.calls.length === 1)) {
          if (stage !== 'left-half') cancelled = true;
          throw limited('LOCAL_OUTPUT_LIMIT');
        }
        if (stage === 'left-half') cancelled = true;
        return { text: JSON.stringify(partial('Supported notes')), model: 'local' };
      });
      await expect(
        generateLocalMeetingNotes(7, {
          checkpoint: () => {
            if (cancelled) throw Object.assign(new Error('Cancelled'), { name: 'AbortError' });
          },
        }),
      ).rejects.toMatchObject({ name: 'AbortError' });
      const expectedCalls = {
        'first-limit': 1,
        'left-half': 2,
        'merge-limit': 5,
        'merge-budget': 4,
      };
      expect(android).toHaveBeenCalledTimes(expectedCalls[stage]);
      expect(apple).not.toHaveBeenCalled();
    },
  );

  it('keeps unrelated Android failures on the existing normalization path', async () => {
    android.mockRejectedValue(new Error('Unrelated native failure'));
    await expect(generateLocalMeetingNotes(7)).rejects.toMatchObject({
      code: 'LOCAL_REASONING_FAILED',
      message: 'Unrelated native failure',
    });
    expect(android).toHaveBeenCalledTimes(1);
  });
});

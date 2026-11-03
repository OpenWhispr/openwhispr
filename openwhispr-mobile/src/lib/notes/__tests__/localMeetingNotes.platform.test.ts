jest.mock('zod', () => {
  const actual = jest.requireActual<typeof import('zod')>('zod');
  return { ...actual, z: { ...actual.z, object: jest.fn(actual.z.object) } };
});
jest.mock('@/lib/appleLLM', () => ({
  AppleLLM: { generateMeetingNotes: jest.fn() },
}));
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
  countLocalInputTokens: jest.fn(async () => 100),
  fitsLocalReasoningBudget: jest.fn(async () => true),
  getLocalInputTokenBudget: jest.fn(() => 2896),
  getLocalReasoningReadiness: jest.fn(async () => ({ status: 'ready' })),
  isLocalContextLimitError: () => false,
  isLocalOutputLimitError: () => false,
  toLocalReasoningError: (error: unknown) => error,
}));
jest.mock('../generateNotesPrompt', () => ({
  buildActionSystemPrompt: jest.fn(() => 'Meeting instructions'),
  isDefaultGenerateNotesAction: () => false,
}));

import { Platform } from 'react-native';
import { AppleLLM } from '@/lib/appleLLM';
import { notesRepository } from '@/data';
import { buildActionSystemPrompt } from '../generateNotesPrompt';
import { generateLocalMeetingNotes } from '../localMeetingNotes';

const originalPlatform = Platform.OS;
const schemaConstructions = jest.requireMock('zod').z.object.mock.calls.length;
const result = {
  summary: 'Confirmed plan',
  keyDiscussionPoints: [],
  decisions: [],
  actionItems: [],
  followUps: [],
};

beforeEach(() => {
  Platform.OS = 'ios';
  jest.clearAllMocks();
  (notesRepository.getNoteById as jest.Mock).mockReturnValue({
    id: 7,
    title: 'Planning',
    content: '',
    noteType: 'meeting',
    deletedAt: null,
    calendarEventId: null,
  });
  (notesRepository.getSegments as jest.Mock).mockReturnValue([
    { id: 1, text: 'We agreed to ship.', startMs: 0, endMs: 1000, speakerLabel: null },
  ]);
  (notesRepository.getSpeakers as jest.Mock).mockReturnValue([]);
  (notesRepository.getActions as jest.Mock).mockReturnValue([]);
  (AppleLLM.generateMeetingNotes as jest.Mock).mockReset().mockResolvedValue(result);
});

afterAll(() => {
  Platform.OS = originalPlatform;
});

it('does not construct an Android response schema when importing the default generator', () => {
  expect(schemaConstructions).toBe(0);
});

it('passes the upstream three-field prompt contract on iOS', async () => {
  await expect(generateLocalMeetingNotes(7, { actionPrompt: 'Custom' })).resolves.toBe(
    'Confirmed plan',
  );
  expect(buildActionSystemPrompt).toHaveBeenCalledWith({
    actionPrompt: 'Custom',
    inputKind: 'meeting-transcript',
    isDefaultGenerateNotesAction: true,
  });
});

it('returns early for a missing iOS note without invoking an Android checkpoint', async () => {
  (notesRepository.getNoteById as jest.Mock).mockReturnValue(null);
  const checkpoint = jest.fn(() => {
    throw new Error('Android cancellation');
  });
  await expect(generateLocalMeetingNotes(7, { checkpoint })).resolves.toBe('');
  expect(checkpoint).not.toHaveBeenCalled();
  expect(AppleLLM.generateMeetingNotes).not.toHaveBeenCalled();
});

it('retains the iOS result when an Android-only checkpoint would cancel after generation', async () => {
  let cancelled = false;
  (AppleLLM.generateMeetingNotes as jest.Mock).mockImplementation(async () => {
    cancelled = true;
    return result;
  });
  const checkpoint = jest.fn(() => {
    if (cancelled) throw new Error('Android cancellation');
  });
  await expect(generateLocalMeetingNotes(7, { checkpoint })).resolves.toBe('Confirmed plan');
  expect(checkpoint).not.toHaveBeenCalled();
  expect(AppleLLM.generateMeetingNotes).toHaveBeenCalledTimes(1);
});

it('does not call a supplied checkpoint during ordinary iOS generation', async () => {
  const checkpoint = jest.fn();
  await expect(generateLocalMeetingNotes(7, { checkpoint })).resolves.toBe('Confirmed plan');
  expect(checkpoint).not.toHaveBeenCalled();
  expect(AppleLLM.generateMeetingNotes).toHaveBeenCalledWith({
    instructions: 'Meeting instructions',
    prompt: expect.any(String),
    temperature: 0.2,
    maxTokens: 900,
  });
});

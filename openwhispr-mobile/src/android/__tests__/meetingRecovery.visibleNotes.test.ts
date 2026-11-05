import * as FileSystem from 'expo-file-system/legacy';
import { eq } from 'drizzle-orm';
import { notes } from '@/db/schema';
import { createMemoryRepository } from '@/data/local/__tests__/testDb';
import { startMeetingRecoveryOnce } from '@/lib/meetingRecovery.android';
import { useNotesStore } from '@/store/useNotesStore';

let mockMemory: ReturnType<typeof createMemoryRepository>;
let mockCurrent = true;
let mockRevision = 0;
jest.mock('@/db', () => ({
  get db() {
    return mockMemory.db;
  },
}));
jest.mock('@/data', () => ({
  get notesRepository() {
    return mockMemory.repo;
  },
}));
jest.mock('expo-sqlite/localStorage/install', () => ({}));
jest.mock('@/lib/meetingRecoveryLifecycle', () => ({
  createMeetingRecoveryLifecycle: () => ({
    begin: () => ({
      directory: null,
      isCurrent: () => mockCurrent,
      getStorage: () => ({ getItem: () => null, setItem: () => {}, removeItem: () => {} }),
    }),
  }),
}));
jest.mock('@/lib/meetingAudioStorage', () => ({
  ...jest.requireActual('@/lib/meetingAudioStorage'),
  meetingAudioContext: () => ({
    namespace: 'account-a',
    key: String(mockRevision),
    isCurrent: () => mockCurrent,
  }),
}));
jest.mock('expo-file-system/legacy', () => ({
  documentDirectory: 'file:///documents/',
  getInfoAsync: jest.fn(async () => ({ exists: true })),
  readDirectoryAsync: jest.fn(),
}));
jest.mock('@/lib/sentry', () => ({ Sentry: { captureException: jest.fn() } }));
jest.mock('@sentry/react-native', () => ({ captureException: jest.fn() }));
jest.mock('@/store/useAuthStore', () => ({
  useAuthStore: { getState: () => ({ user: null }), subscribe: () => () => {} },
}));
jest.mock('@/store/useProcessingModeStore', () => ({
  useProcessingModeStore: { getState: () => ({ activeMode: 'cloud' }), subscribe: () => () => {} },
}));
jest.mock('@/store/useConfigStore', () => ({
  useConfigStore: { getState: () => ({ config: {} }), subscribe: () => () => {} },
}));
jest.mock('@/services/reasoning/ReasoningService', () => ({ ReasoningService: {} }));
jest.mock('@/lib/notes/localMeetingNotes', () => ({ generateLocalMeetingNotes: jest.fn() }));
jest.mock('@/lib/appsflyer', () => ({ logTranscriptionCompleted: jest.fn() }));
jest.mock('@/data/remote/notesApi', () => ({ deleteNote: jest.fn() }));
jest.mock('@/lib/localReasoningFallback', () => ({ promptLocalReasoningFallback: jest.fn() }));

beforeEach(() => {
  mockMemory = createMemoryRepository();
  mockCurrent = true;
  mockRevision += 1;
  useNotesStore.setState({ notes: [], activeFolderId: null, activeSpaceId: null });
  jest.clearAllMocks();
});

it('publishes a repaired recording path to already loaded notes without navigation', async () => {
  const { repo, db } = mockMemory;
  const note = repo.createNote('Retained meeting', 'Unsaved transcript is separate');
  db.update(notes)
    .set({
      noteType: 'meeting',
      transcriptionStatus: 'failed',
      sourceFile: `file:///documents/meeting-${note.id}.wav`,
    })
    .where(eq(notes.id, note.id))
    .run();
  useNotesStore.getState().loadNotes();
  const before = useNotesStore.getState().notes.find((row) => row.id === note.id)!;
  const visiblePaths: (string | null)[] = [];
  const unsubscribe = useNotesStore.subscribe((state) => {
    visiblePaths.push(state.notes.find((row) => row.id === note.id)?.sourceFile ?? null);
  });
  jest.mocked(FileSystem.readDirectoryAsync).mockResolvedValueOnce([`meeting-${note.id}.wav`]);
  try {
    startMeetingRecoveryOnce();
    for (let i = 0; i < 15; i += 1) await Promise.resolve();
    const expected = `file:///documents/account-audio/account-a/meeting-${note.id}.wav`;
    expect(repo.getNoteById(note.id)?.sourceFile).toBe(expected);
    expect(useNotesStore.getState().notes.find((row) => row.id === note.id)).toEqual({
      ...before,
      sourceFile: expected,
    });
    expect(visiblePaths).toContain(expected);
  } finally {
    unsubscribe();
  }
});

it('keeps the current view unchanged when a repair scan belongs to a departed account', async () => {
  const note = mockMemory.repo.createNote('Current account note', 'Keep this view');
  useNotesStore.getState().loadNotes();
  const visibleNotes = useNotesStore.getState().notes;
  let finishScan!: (files: string[]) => void;
  jest.mocked(FileSystem.readDirectoryAsync).mockReturnValueOnce(
    new Promise((resolve) => {
      finishScan = resolve;
    }),
  );
  startMeetingRecoveryOnce();
  for (let i = 0; i < 3; i += 1) await Promise.resolve();
  mockCurrent = false;
  finishScan([`meeting-${note.id}.wav`]);
  for (let i = 0; i < 15; i += 1) await Promise.resolve();
  expect(useNotesStore.getState().notes).toBe(visibleNotes);
  expect(mockMemory.repo.getNoteById(note.id)?.content).toBe('Keep this view');
});

it('recovers an interrupted recording even when refreshing the visible notes fails', async () => {
  const { repo, db } = mockMemory;
  const note = repo.createNote('Interrupted recording', 'Preserve this draft');
  db.update(notes)
    .set({
      noteType: 'meeting',
      transcriptionStatus: 'recording',
      createdAt: '2020-01-01 00:00:00',
    })
    .where(eq(notes.id, note.id))
    .run();
  useNotesStore.getState().loadNotes();
  jest.mocked(FileSystem.readDirectoryAsync).mockResolvedValueOnce([]);
  const refreshError = new Error('Notes query temporarily unavailable');
  const query = jest.spyOn(repo, 'getAllNotes').mockImplementationOnce(() => {
    throw refreshError;
  });
  try {
    startMeetingRecoveryOnce();
    for (let i = 0; i < 20; i += 1) await Promise.resolve();
    startMeetingRecoveryOnce();
    for (let i = 0; i < 20; i += 1) await Promise.resolve();
    expect(repo.getNoteById(note.id)?.transcriptionStatus).toBe('failed');
    expect(repo.getNoteById(note.id)?.content).toBe('Preserve this draft');
    expect(
      useNotesStore.getState().notes.find((row) => row.id === note.id)?.transcriptionStatus,
    ).toBe('failed');
    expect(require('@/lib/sentry').Sentry.captureException).toHaveBeenCalledWith(
      refreshError,
      expect.anything(),
    );
  } finally {
    query.mockRestore();
  }
});

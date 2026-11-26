jest.mock('expo-file-system/legacy', () => ({ documentDirectory: 'file:///app/documents/' }));
jest.mock('@sentry/react-native', () => ({
  captureException: jest.fn(),
  captureMessage: jest.fn(),
  addBreadcrumb: jest.fn(),
}));
jest.mock('@/data/remote/notesApi', () => ({
  deleteNote: jest.fn(),
  fetchNotes: jest.fn(),
  batchCreateNotes: jest.fn(),
  updateNote: jest.fn(),
}));
jest.mock('@/lib/uuid', () => ({ randomUUID: () => 'test-uuid' }));

// Every repository read the store makes after a delete answers "nothing"; the deletes are spied.
const mockRepoFns: Record<string, jest.Mock> = {};
const mockRepo = new Proxy(mockRepoFns, {
  get: (fns, key: string) => {
    fns[key] ??= jest.fn(() => []);
    return fns[key];
  },
});
jest.mock('@/data', () => ({
  get notesRepository() {
    return mockRepo;
  },
  get spacesRepository() {
    return mockRepo;
  },
}));
jest.mock('@/store/useProcessingModeStore', () => ({
  useProcessingModeStore: { getState: () => ({ activeMode: 'cloud' }) },
}));
jest.mock('@/store/useAuthStore', () => ({
  useAuthStore: { getState: () => ({ user: null, isGuest: true }), subscribe: () => () => {} },
}));
jest.mock('@/store/useConfigStore', () => ({
  useConfigStore: { getState: () => ({ config: {} }), subscribe: () => () => {} },
}));
jest.mock('@/utils/generateTitle', () => ({
  generateNoteTitle: jest.fn(),
  deriveLocalTitle: jest.fn(),
}));
jest.mock('@/lib/localReasoningFallback', () => ({ promptLocalReasoningFallback: jest.fn() }));
jest.mock('@/lib/appsflyer', () => ({ logTranscriptionCompleted: jest.fn() }));
jest.mock('@/services/reasoning/ReasoningService', () => ({
  ReasoningService: { processText: jest.fn() },
}));
jest.mock('@/lib/alerts', () => ({ alertMeetingNoteNotDeletable: jest.fn() }));

import { useNotesStore } from '../useNotesStore';
import { registerActiveMeeting } from '@/lib/notes/activeMeeting';
import { alertMeetingNoteNotDeletable } from '@/lib/alerts';

const liveMeeting = (noteId: number): void => {
  registerActiveMeeting({ isActive: () => true, stop: jest.fn(), noteId: () => noteId });
};

beforeEach(() => {
  for (const fn of Object.values(mockRepoFns)) fn.mockClear();
  mockRepo.getNoteById.mockImplementation(() => null);
  jest.mocked(alertMeetingNoteNotDeletable).mockClear();
});

afterEach(() => registerActiveMeeting(null));

describe('deleting during a live meeting', () => {
  it("deleting the live meeting's note is refused", () => {
    liveMeeting(42);
    useNotesStore.getState().deleteNote(42);
    expect(mockRepo.deleteNote).not.toHaveBeenCalled();
    expect(alertMeetingNoteNotDeletable).toHaveBeenCalledTimes(1);
  });

  it('deleting another note during a meeting still works', () => {
    liveMeeting(42);
    useNotesStore.getState().deleteNote(7);
    expect(mockRepo.deleteNote).toHaveBeenCalledWith(7);
    expect(alertMeetingNoteNotDeletable).not.toHaveBeenCalled();
  });

  it('a folder delete containing the live note is refused as a whole', () => {
    liveMeeting(42);
    mockRepo.getNoteById.mockImplementation((id: number) =>
      id === 42 ? { id: 42, folderId: 5 } : null,
    );
    useNotesStore.getState().deleteFolderSafe(5);
    expect(mockRepo.deleteFolderCascade).not.toHaveBeenCalled();
    expect(alertMeetingNoteNotDeletable).toHaveBeenCalledTimes(1);
  });

  it('a folder delete that does not hold the live note still works', () => {
    liveMeeting(42);
    mockRepo.getNoteById.mockImplementation((id: number) =>
      id === 42 ? { id: 42, folderId: 9 } : null,
    );
    useNotesStore.getState().deleteFolderSafe(5);
    expect(mockRepo.deleteFolderCascade).toHaveBeenCalledWith(5);
  });

  it('deletes freely with no meeting running', () => {
    useNotesStore.getState().deleteNote(42);
    expect(mockRepo.deleteNote).toHaveBeenCalledWith(42);
  });
});

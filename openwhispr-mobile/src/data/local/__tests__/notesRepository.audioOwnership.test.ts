jest.mock('expo-file-system/legacy', () => ({
  documentDirectory: 'file:///app/documents/',
  deleteAsync: jest.fn().mockResolvedValue(undefined),
}));
import * as FileSystem from 'expo-file-system/legacy';
import { createMemoryRepository } from './testDb';

beforeEach(() => {
  jest.clearAllMocks();
});

it.each(['hardDeleteNote', 'deleteNote', 'wipeAllSyncableData'] as const)(
  '%s never deletes an arbitrary synced source_file path',
  (operation) => {
    const { repo } = createMemoryRepository();
    const note = repo.createNote('Remote', '');
    repo.updateNoteMeta(note.id, { sourceFile: `${FileSystem.documentDirectory}SQLite/app.db` });
    repo[operation](note.id);
    expect(FileSystem.deleteAsync).not.toHaveBeenCalled();
  },
);

it('removes the recording owned by the deleted note', () => {
  const { repo } = createMemoryRepository();
  const note = repo.createNote('Local', '');
  const uri = `${FileSystem.documentDirectory}meeting-${note.id}.wav`;
  repo.updateNoteMeta(note.id, { sourceFile: uri });
  repo.hardDeleteNote(note.id);
  expect(FileSystem.deleteAsync).toHaveBeenCalledWith(uri, { idempotent: true });
});

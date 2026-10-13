jest.mock('expo-file-system/legacy', () => ({
  documentDirectory: 'file:///app/documents/',
  deleteAsync: jest.fn().mockResolvedValue(undefined),
}));
import * as FileSystem from 'expo-file-system/legacy';
import { eq } from 'drizzle-orm';
import { notes } from '@/db/schema';
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

it('restores a missing recording path without moving the note in lists', () => {
  const { repo, db } = createMemoryRepository();
  const note = repo.createNote('Local', '');
  db.update(notes).set({ updatedAt: '2026-01-01 00:00:00' }).where(eq(notes.id, note.id)).run();
  const uri = `${FileSystem.documentDirectory}meeting-${note.id}.wav`;

  repo.restoreMeetingRecordingPath(note.id, uri);

  expect(repo.getNoteById(note.id)).toEqual(
    expect.objectContaining({ sourceFile: uri, updatedAt: '2026-01-01 00:00:00' }),
  );
});

it('never replaces a recording path a note already has', () => {
  const { repo } = createMemoryRepository();
  const note = repo.createNote('Remote', '');
  repo.updateNoteMeta(note.id, { sourceFile: 'https://cdn.example/a.wav' });

  repo.restoreMeetingRecordingPath(note.id, `${FileSystem.documentDirectory}meeting-1.wav`);

  expect(repo.getNoteById(note.id)?.sourceFile).toBe('https://cdn.example/a.wav');
});

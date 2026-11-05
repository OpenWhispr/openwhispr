import { folders, spaces } from '@/db/schema';
import { createMemoryRepository } from './testDb';

describe('upstream iOS note repository boundary', () => {
  it('retains upstream folder 1 when no folder was supplied', () => {
    const { repo } = createMemoryRepository();
    expect(repo.createNote('Title', 'Body')).toMatchObject({ folderId: 1 });
  });

  it('retains a requested missing folder instead of Android default-folder recovery', () => {
    const { repo, db } = createMemoryRepository();
    const privateSpace = db.select().from(spaces).get()!;
    db.insert(folders)
      .values({ id: 41, name: 'Personal', isDefault: 1, spaceId: privateSpace.id })
      .run();
    expect(repo.createNote('Title', 'Body', 999)).toMatchObject({
      title: 'Title',
      content: 'Body',
      folderId: 999,
      spaceId: privateSpace.id,
    });
  });

  it('retains the supplied space without Android live-space validation', () => {
    const { repo } = createMemoryRepository();
    expect(repo.createNote('Title', 'Body', undefined, 999)).toMatchObject({
      folderId: null,
      spaceId: 999,
    });
  });

  it('does not clear the Android meeting retry key when deleting a note', () => {
    const { repo } = createMemoryRepository();
    const note = repo.createNote('Meeting', 'Keep other state');
    const key = `meeting.transcription_id:${note.id}`;
    repo.setSyncState(key, 'synthetic-retry-id');
    repo.deleteNote(note.id);
    expect(repo.getNoteById(note.id)?.deletedAt).not.toBeNull();
    expect(repo.getSyncState(key)).toBe('synthetic-retry-id');
  });
});

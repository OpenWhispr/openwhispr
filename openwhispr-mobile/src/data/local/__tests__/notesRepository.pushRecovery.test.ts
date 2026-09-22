import { eq } from 'drizzle-orm';
import { folders, notes } from '@/db/schema';
import { createMemoryRepository, type TestDb } from './testDb';

const noteRow = (db: TestDb, id: number) => db.select().from(notes).where(eq(notes.id, id)).get()!;
const folderRow = (db: TestDb, id: number) =>
  db.select().from(folders).where(eq(folders.id, id)).get()!;

describe('LocalNotesRepository.markFolderTerminal', () => {
  it('clears pendingSync and leaves every other column untouched', () => {
    const { repo, db } = createMemoryRepository();
    const folder = repo.createFolder('Design');
    db.update(folders)
      .set({ pendingSync: 1, remoteId: 'remote-folder-1' })
      .where(eq(folders.id, folder.id))
      .run();

    repo.markFolderTerminal(folder.id);

    const row = folderRow(db, folder.id);
    expect(row.pendingSync).toBe(0);
    expect(row.name).toBe('Design');
    expect(row.remoteId).toBe('remote-folder-1');
    expect(row.deletedAt).toBeNull();
  });
});

describe('LocalNotesRepository.dropNotePushAttempt', () => {
  it('clears pendingSync and the cloud base, keeping the local content and remote id', () => {
    const { repo, db } = createMemoryRepository();
    const note = repo.createNote('Title', 'Body');
    db.update(notes)
      .set({
        pendingSync: 1,
        remoteId: 'remote-note-1',
        cloudUpdatedAt: '2026-08-24T09:00:00.000Z',
      })
      .where(eq(notes.id, note.id))
      .run();

    repo.dropNotePushAttempt(note.id);

    const row = noteRow(db, note.id);
    expect(row.pendingSync).toBe(0);
    // Nulled so the next pull re-seeds the base from server truth instead of
    // this device's rejected assumption.
    expect(row.cloudUpdatedAt).toBeNull();
    expect(row.remoteId).toBe('remote-note-1');
    expect(row.content).toBe('Body');
  });

  it('leaves the row out of the pending push queue', () => {
    const { repo, db } = createMemoryRepository();
    const note = repo.createNote('Title', 'Body');
    db.update(notes).set({ pendingSync: 1 }).where(eq(notes.id, note.id)).run();

    repo.dropNotePushAttempt(note.id);

    expect(repo.getPendingNotes()).toHaveLength(0);
  });
});

describe('LocalNotesRepository.adoptDuplicateFolder', () => {
  it('points the surviving row at the server identity and clears its pendingSync', () => {
    const { repo, db } = createMemoryRepository();
    const surviving = repo.createFolder('Personal');
    db.update(folders).set({ pendingSync: 1 }).where(eq(folders.id, surviving.id)).run();
    const duplicate = db
      .insert(folders)
      .values({ name: 'Personal', remoteId: 'srv-personal-1', spaceId: surviving.spaceId })
      .returning()
      .get();

    repo.adoptDuplicateFolder(
      surviving.id,
      duplicate.id,
      'srv-personal-1',
      '2026-08-24T10:00:00.000Z',
    );

    const row = folderRow(db, surviving.id);
    expect(row.remoteId).toBe('srv-personal-1');
    expect(row.pendingSync).toBe(0);
    expect(row.updatedAt).toBe('2026-08-24T10:00:00.000Z');
  });

  it('removes the duplicate row', () => {
    const { repo, db } = createMemoryRepository();
    const surviving = repo.createFolder('Personal');
    const duplicate = db
      .insert(folders)
      .values({ name: 'Personal', remoteId: 'srv-personal-1', spaceId: surviving.spaceId })
      .returning()
      .get();

    repo.adoptDuplicateFolder(
      surviving.id,
      duplicate.id,
      'srv-personal-1',
      '2026-08-24T10:00:00.000Z',
    );

    expect(db.select().from(folders).where(eq(folders.id, duplicate.id)).all()).toEqual([]);
  });

  it('re-parents notes filed under the duplicate onto the surviving folder, without flagging them pending', () => {
    const { repo, db } = createMemoryRepository();
    const surviving = repo.createFolder('Personal');
    const duplicate = db
      .insert(folders)
      .values({ name: 'Personal', remoteId: 'srv-personal-1', spaceId: surviving.spaceId })
      .returning()
      .get();
    // A note pulled in under the duplicate in the same run (its remote
    // folder_id resolved to the duplicate row, which pullFolders had just
    // inserted as a second local "Personal").
    const orphaned = db
      .insert(notes)
      .values({ title: 'Pulled under duplicate', content: '', folderId: duplicate.id })
      .returning()
      .get();

    repo.adoptDuplicateFolder(
      surviving.id,
      duplicate.id,
      'srv-personal-1',
      '2026-08-24T10:00:00.000Z',
    );

    const row = noteRow(db, orphaned.id);
    expect(row.folderId).toBe(surviving.id);
    // No push implication: both local rows already resolved to the same
    // server folder, so this is a pure local FK fixup — never mark pending.
    expect(row.pendingSync).toBe(0);
  });

  it('leaves a note filed under an unrelated folder untouched', () => {
    const { repo, db } = createMemoryRepository();
    const surviving = repo.createFolder('Personal');
    const duplicate = db
      .insert(folders)
      .values({ name: 'Personal', remoteId: 'srv-personal-1', spaceId: surviving.spaceId })
      .returning()
      .get();
    const other = repo.createFolder('Meetings');
    const untouched = db
      .insert(notes)
      .values({ title: 'Elsewhere', content: '', folderId: other.id })
      .returning()
      .get();

    repo.adoptDuplicateFolder(
      surviving.id,
      duplicate.id,
      'srv-personal-1',
      '2026-08-24T10:00:00.000Z',
    );

    expect(noteRow(db, untouched.id).folderId).toBe(other.id);
  });
});

describe('LocalNotesRepository.clearSyncState', () => {
  it('removes the key so it reads back as null, unlike storing an empty string', () => {
    const { repo } = createMemoryRepository();
    repo.setSyncState('notes.team.last_sync_at', '2026-08-24T10:00:00.000Z');

    repo.clearSyncState('notes.team.last_sync_at');

    expect(repo.getSyncState('notes.team.last_sync_at')).toBeNull();
  });

  it('touches only the key it was given and tolerates a key that was never set', () => {
    const { repo } = createMemoryRepository();
    repo.setSyncState('notes.team.last_sync_at', '2026-08-24T10:00:00.000Z');
    repo.setSyncState('notes.last_sync_at', '2026-08-24T11:00:00.000Z');

    repo.clearSyncState('notes.team.last_sync_at');
    expect(() => repo.clearSyncState('folders.team.last_sync_at')).not.toThrow();

    expect(repo.getSyncState('notes.last_sync_at')).toBe('2026-08-24T11:00:00.000Z');
  });
});

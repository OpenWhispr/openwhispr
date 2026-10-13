import { eq } from 'drizzle-orm';
import { folders, notes, spaces } from '@/db/schema';
import type { RemoteNote } from '@/data/types';
import { isFolderAwaitingUpload } from '@/lib/notes/folderUpload';
import { randomUUID } from '@/lib/uuid';
import { createMemoryRepository, type TestDb } from './testDb';
import type { LocalNotesRepository } from '../notesRepository';

// A note filed in a folder with no cloud id reaches the server unfiled. These pin how the
// pull treats that note when it comes back, and which folders hold a note's push back.

const remoteNote = (over: Partial<RemoteNote> = {}): RemoteNote => ({
  id: 'srv-1',
  client_note_id: 'client-1',
  title: 'Sync Meeting',
  content: '',
  enhanced_content: null,
  enhancement_prompt: null,
  note_type: 'meeting',
  source_file: null,
  audio_duration_seconds: null,
  folder_id: null,
  participants: null,
  calendar_event_id: null,
  transcript: null,
  deleted_at: null,
  updated_at: '2026-07-09T10:00:00.000Z',
  ...over,
});
const noFolder = (): number | null => null;
const echo = remoteNote({ updated_at: '2026-07-09T11:00:00.000Z' });

const setUp = (): { repo: LocalNotesRepository; db: TestDb; noteId: number } => {
  const { repo, db } = createMemoryRepository();
  repo.applyRemoteNote(remoteNote(), noFolder);
  const [note] = repo.getAllNotes();
  return { repo, db, noteId: note.id };
};

const fileNote = (db: TestDb, noteId: number, folderId: number): void => {
  db.update(notes).set({ folderId }).where(eq(notes.id, noteId)).run();
};

const createTeamSpace = (db: TestDb): number =>
  db
    .insert(spaces)
    .values({
      clientSpaceId: randomUUID(),
      cloudSpaceId: 'cloud-space-1',
      kind: 'team',
      name: 'Eng',
    })
    .returning()
    .get().id;

// Reads the folder the way pushNotes and ensureNoteSynced do.
const awaitsUpload = (repo: LocalNotesRepository, folderId: number): boolean =>
  isFolderAwaitingUpload(repo.getFolders().find(({ id }) => id === folderId));

describe('isFolderAwaitingUpload', () => {
  it('is true for a queued folder with a client id and no cloud id', () => {
    const { repo } = createMemoryRepository();
    const folder = repo.createFolder('Meetings');
    repo.setFolderClientId(folder.id, 'client-folder');

    expect(awaitsUpload(repo, folder.id)).toBe(true);
  });

  it('is false once the folder has a cloud id, and for no folder at all', () => {
    const { repo } = createMemoryRepository();
    const folder = repo.createFolder('Meetings');
    repo.setFolderClientId(folder.id, 'client-folder');
    repo.markFolderPushed(folder.id, 'srv-folder', '2026-07-09T10:00:00.000Z');

    expect(awaitsUpload(repo, folder.id)).toBe(false);
    expect(isFolderAwaitingUpload(null)).toBe(false);
    expect(awaitsUpload(repo, 404)).toBe(false);
  });

  it('is false for a synced folder queued again by a rename', () => {
    const { repo } = createMemoryRepository();
    const folder = repo.createFolder('Meetings');
    repo.setFolderClientId(folder.id, 'client-folder');
    repo.markFolderPushed(folder.id, 'srv-folder', '2026-07-09T10:00:00.000Z');
    repo.renameFolder(folder.id, 'Calls');

    expect(awaitsUpload(repo, folder.id)).toBe(false);
  });

  it('is false for a folder pushFolders will never upload', () => {
    const { repo, db } = createMemoryRepository();
    // A re-seeded default: no client id, not queued.
    const reseeded = repo.createFolder('Personal');
    db.update(folders).set({ pendingSync: 0 }).where(eq(folders.id, reseeded.id)).run();
    // Queued, but with no client id pushFolders skips it.
    const noClientId = repo.createFolder('Drafts');
    // Refused by the server.
    const refused = repo.createFolder('Clients');
    repo.setFolderClientId(refused.id, 'client-refused');
    repo.markFolderTerminal(refused.id);

    expect(awaitsUpload(repo, reseeded.id)).toBe(false);
    expect(awaitsUpload(repo, noClientId.id)).toBe(false);
    expect(awaitsUpload(repo, refused.id)).toBe(false);
  });

  it('is false for a deleted folder', () => {
    const { repo } = createMemoryRepository();
    const folder = repo.createFolder('Old');
    repo.setFolderClientId(folder.id, 'client-folder');
    repo.deleteFolder(folder.id);

    expect(awaitsUpload(repo, folder.id)).toBe(false);
    // Deleting queues the folder again, so the row itself must say no too.
    const deleted = repo.getFoldersIncludingDeleted().find(({ id }) => id === folder.id);
    expect(deleted?.pendingSync).toBe(1);
    expect(isFolderAwaitingUpload(deleted)).toBe(false);
  });
});

describe('applyRemoteNote folder echo', () => {
  it('keeps the folder and queues the note again while the folder is on its way up', () => {
    const { repo, db, noteId } = setUp();
    const folder = repo.createFolder('Meetings');
    repo.setFolderClientId(folder.id, 'client-folder');
    fileNote(db, noteId, folder.id);

    repo.applyRemoteNote(echo, noFolder);

    const note = repo.getNoteById(noteId);
    expect(note?.folderId).toBe(folder.id);
    expect(note?.pendingSync).toBe(1);
    expect(note?.cloudUpdatedAt).toBe(echo.updated_at);
  });

  it('keeps the folder without queueing the note when the folder will never upload', () => {
    const { repo, db, noteId } = setUp();
    const folder = repo.createFolder('Clients');
    repo.setFolderClientId(folder.id, 'client-folder');
    repo.markFolderTerminal(folder.id);
    fileNote(db, noteId, folder.id);

    repo.applyRemoteNote(echo, noFolder);

    const note = repo.getNoteById(noteId);
    expect(note?.folderId).toBe(folder.id);
    // Queued again, it would go up unfiled and echo back forever.
    expect(note?.pendingSync).toBe(0);
  });

  it('follows the server when it takes a note out of a folder it knows', () => {
    const { repo, db, noteId } = setUp();
    const folder = repo.createFolder('Clients');
    db.update(folders).set({ remoteId: 'srv-folder-1' }).where(eq(folders.id, folder.id)).run();
    fileNote(db, noteId, folder.id);

    repo.applyRemoteNote(echo, noFolder);

    expect(repo.getNoteById(noteId)?.folderId).toBeNull();
    expect(repo.getNoteById(noteId)?.pendingSync).toBe(0);
  });

  it('follows the server when it files the note in another folder', () => {
    const { repo, db, noteId } = setUp();
    const unsynced = repo.createFolder('Meetings');
    repo.setFolderClientId(unsynced.id, 'client-folder');
    const known = repo.createFolder('Clients');
    db.update(folders).set({ remoteId: 'srv-folder-2' }).where(eq(folders.id, known.id)).run();
    fileNote(db, noteId, unsynced.id);

    repo.applyRemoteNote(remoteNote({ ...echo, folder_id: 'srv-folder-2' }), () => known.id);

    expect(repo.getNoteById(noteId)?.folderId).toBe(known.id);
    expect(repo.getNoteById(noteId)?.pendingSync).toBe(0);
  });

  it('follows the server when the team pass moves the note out of the folder’s space', () => {
    const { repo, db, noteId } = setUp();
    const folder = repo.createFolder('Meetings');
    repo.setFolderClientId(folder.id, 'client-folder');
    fileNote(db, noteId, folder.id);
    const teamSpaceId = createTeamSpace(db);

    repo.applyRemoteNote(echo, noFolder, { spaceId: teamSpaceId });

    const note = repo.getNoteById(noteId);
    expect(note?.spaceId).toBe(teamSpaceId);
    expect(note?.folderId).toBeNull();
    expect(note?.pendingSync).toBe(0);
  });

  it('keeps the folder when the team pass leaves the note in the folder’s space', () => {
    const { repo, db, noteId } = setUp();
    const teamSpaceId = createTeamSpace(db);
    const folder = repo.createFolder('Standup', teamSpaceId);
    repo.setFolderClientId(folder.id, 'client-folder');
    db.update(notes)
      .set({ folderId: folder.id, spaceId: teamSpaceId })
      .where(eq(notes.id, noteId))
      .run();

    repo.applyRemoteNote(echo, noFolder, { spaceId: teamSpaceId });

    const note = repo.getNoteById(noteId);
    expect(note?.folderId).toBe(folder.id);
    expect(note?.pendingSync).toBe(1);
  });

  it('follows the server when the note sits in a deleted folder', () => {
    const { repo, db, noteId } = setUp();
    const folder = repo.createFolder('Old');
    fileNote(db, noteId, folder.id);
    repo.deleteFolder(folder.id);

    repo.applyRemoteNote(echo, noFolder);

    expect(repo.getNoteById(noteId)?.folderId).toBeNull();
  });
});

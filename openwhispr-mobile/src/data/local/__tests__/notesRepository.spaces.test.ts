import { eq } from 'drizzle-orm';
import { folderDeleteJournal, folders, notes, spaces } from '@/db/schema';
import type { RemoteFolder, RemoteNote } from '@/data/types';
import { randomUUID } from '@/lib/uuid';
import { createMemoryRepository, type TestDb } from './testDb';

const remoteNote = (over: Partial<RemoteNote> = {}): RemoteNote => ({
  id: 'srv-note-1',
  client_note_id: 'client-note-1',
  title: 'Remote title',
  content: 'Remote content',
  enhanced_content: null,
  enhancement_prompt: null,
  note_type: 'personal',
  source_file: null,
  audio_duration_seconds: null,
  folder_id: null,
  participants: null,
  calendar_event_id: null,
  transcript: null,
  deleted_at: null,
  updated_at: '2026-08-24T10:00:00.000Z',
  ...over,
});

const remoteFolder = (over: Partial<RemoteFolder> = {}): RemoteFolder => ({
  id: 'srv-folder-1',
  client_folder_id: 'client-folder-1',
  name: 'Remote folder',
  is_default: false,
  sort_order: 0,
  deleted_at: null,
  updated_at: '2026-08-24T10:00:00.000Z',
  ...over,
});

const noFolder = (): number | null => null;

const noteRow = (db: TestDb, id: number) => db.select().from(notes).where(eq(notes.id, id)).get()!;

const privateSpaceId = (db: TestDb): number =>
  db.select().from(spaces).where(eq(spaces.kind, 'private')).get()!.id;

const createTeamSpace = (db: TestDb, over: Partial<typeof spaces.$inferInsert> = {}): number =>
  db
    .insert(spaces)
    .values({
      clientSpaceId: randomUUID(),
      cloudSpaceId: 'cloud-space-1',
      kind: 'team',
      name: 'Engineering',
      ...over,
    })
    .returning()
    .get().id;

describe('LocalNotesRepository — space_id is never left NULL on apply', () => {
  it('files a personal-pass note insert into the private space', () => {
    const { repo, db } = createMemoryRepository();

    repo.applyRemoteNote(remoteNote(), noFolder);

    const [note] = repo.getAllNotes();
    expect(note.spaceId).toBe(privateSpaceId(db));
  });

  it('files a personal-pass folder insert into the private space', () => {
    const { repo, db } = createMemoryRepository();

    repo.applyRemoteFolder(remoteFolder());

    const [folder] = repo.getFolders();
    expect(folder.spaceId).toBe(privateSpaceId(db));
  });

  it('files a team-pass note insert into the space the caller resolved', () => {
    const { repo, db } = createMemoryRepository();
    const teamSpaceId = createTeamSpace(db);

    repo.applyRemoteNote(remoteNote(), noFolder, { spaceId: teamSpaceId });

    const [note] = repo.getAllNotes();
    expect(note.spaceId).toBe(teamSpaceId);
  });

  it('files a team-pass folder insert into the space the caller resolved', () => {
    const { repo, db } = createMemoryRepository();
    const teamSpaceId = createTeamSpace(db);

    repo.applyRemoteFolder(remoteFolder(), { spaceId: teamSpaceId });

    const [folder] = repo.getFolders();
    expect(folder.spaceId).toBe(teamSpaceId);
  });
});

describe('LocalNotesRepository — space relocation on update', () => {
  it('moves an existing note into the space the team pass resolved', () => {
    const { repo, db } = createMemoryRepository();
    const teamSpaceId = createTeamSpace(db);
    repo.applyRemoteNote(remoteNote(), noFolder);
    const [inserted] = repo.getAllNotes();
    expect(inserted.spaceId).toBe(privateSpaceId(db));

    repo.applyRemoteNote(
      remoteNote({ title: 'Now in a team', updated_at: '2026-08-24T11:00:00.000Z' }),
      noFolder,
      { spaceId: teamSpaceId },
    );

    expect(noteRow(db, inserted.id).spaceId).toBe(teamSpaceId);
  });

  it('leaves an existing note where it is when no space is supplied (personal pass)', () => {
    const { repo, db } = createMemoryRepository();
    const teamSpaceId = createTeamSpace(db);
    repo.applyRemoteNote(remoteNote(), noFolder, { spaceId: teamSpaceId });
    const [inserted] = repo.getAllNotes();

    repo.applyRemoteNote(
      remoteNote({ title: 'Personal-pass update', updated_at: '2026-08-24T11:00:00.000Z' }),
      noFolder,
    );

    expect(noteRow(db, inserted.id).spaceId).toBe(teamSpaceId);
  });

  it('moves an existing folder into the resolved space, and leaves it alone without one', () => {
    const { repo, db } = createMemoryRepository();
    const teamSpaceId = createTeamSpace(db);
    repo.applyRemoteFolder(remoteFolder());
    const [inserted] = repo.getFolders();

    repo.applyRemoteFolder(
      remoteFolder({ name: 'Moved', updated_at: '2026-08-24T11:00:00.000Z' }),
      { spaceId: teamSpaceId },
    );
    expect(db.select().from(folders).where(eq(folders.id, inserted.id)).get()!.spaceId).toBe(
      teamSpaceId,
    );

    repo.applyRemoteFolder(
      remoteFolder({ name: 'Renamed', updated_at: '2026-08-24T12:00:00.000Z' }),
    );
    expect(db.select().from(folders).where(eq(folders.id, inserted.id)).get()!.spaceId).toBe(
      teamSpaceId,
    );
  });
});

describe('LocalNotesRepository — cloud ownership', () => {
  const owned = remoteNote({ user_id: 'owner-1', updated_by_user_id: 'editor-2' });

  it('persists owner and last editor on a team-pass insert', () => {
    const { repo } = createMemoryRepository();

    repo.applyRemoteNote(owned, noFolder, { applyOwnership: true });

    const [note] = repo.getAllNotes();
    expect(note.ownerUserId).toBe('owner-1');
    expect(note.updatedByUserId).toBe('editor-2');
  });

  it('persists owner and last editor on a team-pass update', () => {
    const { repo, db } = createMemoryRepository();
    repo.applyRemoteNote(remoteNote(), noFolder);
    const [inserted] = repo.getAllNotes();

    repo.applyRemoteNote(
      remoteNote({
        user_id: 'owner-1',
        updated_by_user_id: 'editor-2',
        updated_at: '2026-08-24T11:00:00.000Z',
      }),
      noFolder,
      { applyOwnership: true },
    );

    expect(noteRow(db, inserted.id).ownerUserId).toBe('owner-1');
    expect(noteRow(db, inserted.id).updatedByUserId).toBe('editor-2');
  });

  it('never writes ownership on the personal pass, even when the row carries it', () => {
    const { repo } = createMemoryRepository();

    repo.applyRemoteNote(owned, noFolder);

    const [note] = repo.getAllNotes();
    expect(note.ownerUserId).toBeNull();
    expect(note.updatedByUserId).toBeNull();
  });

  it('keeps a known owner when a later team-pass row omits the field', () => {
    const { repo, db } = createMemoryRepository();
    repo.applyRemoteNote(owned, noFolder, { applyOwnership: true });
    const [inserted] = repo.getAllNotes();

    repo.applyRemoteNote(remoteNote({ updated_at: '2026-08-24T11:00:00.000Z' }), noFolder, {
      applyOwnership: true,
    });

    expect(noteRow(db, inserted.id).ownerUserId).toBe('owner-1');
  });
});

describe('LocalNotesRepository.getFoldersIncludingDeleted', () => {
  it('returns soft-deleted folders that getFolders() hides, so the team pull can still resolve them', () => {
    const { repo } = createMemoryRepository();
    const live = repo.createFolder('Live');
    const removed = repo.createFolder('Removed');
    repo.deleteFolder(removed.id);

    expect(repo.getFolders().map((f) => f.id)).toEqual([live.id]);
    expect(
      repo
        .getFoldersIncludingDeleted()
        .map((f) => f.id)
        .sort(),
    ).toEqual([live.id, removed.id].sort());
    expect(repo.getFoldersIncludingDeleted().find((f) => f.id === removed.id)?.deletedAt).toEqual(
      expect.any(String),
    );
  });
});

describe('LocalNotesRepository.getPrivateFolders', () => {
  it('returns private-space folders only, leaving getFolders (the sync-side view) untouched', () => {
    const { repo, db } = createMemoryRepository();
    const teamSpaceId = createTeamSpace(db);
    const personal = repo.createFolder('Personal folder');
    repo.applyRemoteFolder(remoteFolder({ name: 'Team folder' }), { spaceId: teamSpaceId });

    expect(repo.getPrivateFolders().map((f) => f.name)).toEqual(['Personal folder']);
    // Sync-side callers (pullNotes/pushNotes/pushFolders) still see everything.
    expect(
      repo
        .getFolders()
        .map((f) => f.name)
        .sort(),
    ).toEqual(['Personal folder', 'Team folder']);
    expect(repo.getPrivateFolders().map((f) => f.id)).toEqual([personal.id]);
  });

  it('hides soft-deleted private folders, exactly like getFolders', () => {
    const { repo } = createMemoryRepository();
    const live = repo.createFolder('Live');
    const removed = repo.createFolder('Removed');
    repo.deleteFolder(removed.id);

    expect(repo.getPrivateFolders().map((f) => f.id)).toEqual([live.id]);
  });
});

describe('LocalNotesRepository.getFolderByRemoteId', () => {
  it('resolves the local row for a server folder id, and null when nothing matches', () => {
    const { repo } = createMemoryRepository();
    repo.applyRemoteFolder(remoteFolder());
    const [folder] = repo.getFolders();

    expect(repo.getFolderByRemoteId('srv-folder-1')?.id).toBe(folder.id);
    expect(repo.getFolderByRemoteId('srv-folder-unknown')).toBeNull();
  });

  it('never matches a folder that only carries a client id — a stub is about a synced row', () => {
    const { repo } = createMemoryRepository();
    repo.createFolder('Never pushed');

    expect(repo.getFolderByRemoteId('srv-folder-1')).toBeNull();
  });
});

describe('LocalNotesRepository.getNoteForRemote', () => {
  it('matches on client_note_id', () => {
    const { repo } = createMemoryRepository();
    repo.applyRemoteNote(remoteNote(), noFolder);
    const [note] = repo.getAllNotes();

    expect(
      repo.getNoteForRemote({ id: 'other-server-id', client_note_id: 'client-note-1' })?.id,
    ).toBe(note.id);
  });

  it('falls back to remote_id when the remote row carries no client id', () => {
    const { repo } = createMemoryRepository();
    repo.applyRemoteNote(remoteNote(), noFolder);
    const [note] = repo.getAllNotes();

    expect(repo.getNoteForRemote({ id: 'srv-note-1', client_note_id: null })?.id).toBe(note.id);
  });

  it('returns null when nothing matches', () => {
    const { repo } = createMemoryRepository();

    expect(repo.getNoteForRemote({ id: 'nope', client_note_id: 'nope' })).toBeNull();
  });
});

describe('LocalNotesRepository.forkNoteToPrivate', () => {
  it('re-homes the note as a brand-new personal note with no cloud identity', () => {
    const { repo, db } = createMemoryRepository();
    const teamSpaceId = createTeamSpace(db);
    const folder = repo.createFolder('Team folder');
    const inserted = db
      .insert(notes)
      .values({
        title: 'Team note',
        content: 'unpushed work',
        folderId: folder.id,
        spaceId: teamSpaceId,
        clientNoteId: 'client-note-1',
        remoteId: 'srv-note-1',
        cloudUpdatedAt: '2026-08-24T10:00:00.000Z',
        ownerUserId: 'owner-1',
        updatedByUserId: 'editor-2',
        leftTeam: 1,
        conflictServerNote: JSON.stringify(remoteNote()),
        pendingSync: 1,
        updatedAt: '2026-08-24T10:00:00.000Z',
      })
      .returning()
      .get();

    repo.forkNoteToPrivate(inserted.id);

    const after = noteRow(db, inserted.id);
    expect(after.spaceId).toBe(privateSpaceId(db));
    expect(after.folderId).toBeNull();
    expect(after.clientNoteId).not.toBe('client-note-1');
    expect(after.clientNoteId).toEqual(expect.any(String));
    expect(after.remoteId).toBeNull();
    expect(after.cloudUpdatedAt).toBeNull();
    expect(after.ownerUserId).toBeNull();
    expect(after.updatedByUserId).toBeNull();
    expect(after.leftTeam).toBe(0);
    expect(after.conflictServerNote).toBeNull();
    // Still queued: the next push re-creates it as a fresh personal note.
    expect(after.pendingSync).toBe(1);
    expect(after.updatedAt).not.toBe('2026-08-24T10:00:00.000Z');
    // Content is untouched — the whole point is preserving unpushed work.
    expect(after.title).toBe('Team note');
    expect(after.content).toBe('unpushed work');
  });

  it('makes the forked note eligible for push again (the parked conflict is gone)', () => {
    const { repo, db } = createMemoryRepository();
    const inserted = db
      .insert(notes)
      .values({
        title: 'Parked',
        content: 'x',
        pendingSync: 1,
        conflictServerNote: JSON.stringify(remoteNote()),
      })
      .returning()
      .get();
    expect(repo.getPendingNotes().map((n) => n.id)).not.toContain(inserted.id);

    repo.forkNoteToPrivate(inserted.id);

    expect(repo.getPendingNotes().map((n) => n.id)).toContain(inserted.id);
  });
});

describe('LocalNotesRepository.getNotesBySpace', () => {
  it('returns only notes filed in the given space, mirroring getNotesByFolder', () => {
    const { repo, db } = createMemoryRepository();
    const teamSpaceId = createTeamSpace(db);
    const inTeam = db
      .insert(notes)
      .values({ title: 'Team note', content: '', spaceId: teamSpaceId })
      .returning()
      .get();
    db.insert(notes)
      .values({ title: 'Personal note', content: '', spaceId: privateSpaceId(db) })
      .run();

    expect(repo.getNotesBySpace(teamSpaceId).map((n) => n.id)).toEqual([inTeam.id]);
  });

  it('excludes soft-deleted notes', () => {
    const { repo, db } = createMemoryRepository();
    const teamSpaceId = createTeamSpace(db);
    const deleted = db
      .insert(notes)
      .values({
        title: 'Gone',
        content: '',
        spaceId: teamSpaceId,
        deletedAt: '2026-08-24T10:00:00.000Z',
      })
      .returning()
      .get();

    expect(repo.getNotesBySpace(teamSpaceId).map((n) => n.id)).not.toContain(deleted.id);
  });

  it('returns an empty array for a space with no notes', () => {
    const { repo, db } = createMemoryRepository();
    const teamSpaceId = createTeamSpace(db);

    expect(repo.getNotesBySpace(teamSpaceId)).toEqual([]);
  });
});

describe('LocalNotesRepository.createFolder', () => {
  it('creates in the private space by default', () => {
    const { repo, db } = createMemoryRepository();

    const folder = repo.createFolder('Personal ideas');

    expect(folder.spaceId).toBe(privateSpaceId(db));
  });

  it('creates inside the given team space, and the folder shows up in that space', () => {
    const { repo, db } = createMemoryRepository();
    const teamSpaceId = createTeamSpace(db);

    const folder = repo.createFolder('Specs', teamSpaceId);

    expect(folder.spaceId).toBe(teamSpaceId);
    expect(repo.getFoldersBySpace(teamSpaceId).map((f) => f.id)).toEqual([folder.id]);
    expect(repo.getPrivateFolders().map((f) => f.id)).not.toContain(folder.id);
  });

  it('marks the new team folder pending so the next push carries it', () => {
    const { repo, db } = createMemoryRepository();
    const teamSpaceId = createTeamSpace(db);

    const folder = repo.createFolder('Specs', teamSpaceId);

    expect(repo.getPendingFolders().map((f) => f.id)).toContain(folder.id);
  });
});

describe('LocalNotesRepository.createNote scope', () => {
  it('files a note created directly in a space into that space, in no folder', () => {
    const { repo, db } = createMemoryRepository();
    const teamSpaceId = createTeamSpace(db);

    const note = repo.createNote('Team note', '', undefined, teamSpaceId);

    const row = noteRow(db, note.id);
    expect(row.spaceId).toBe(teamSpaceId);
    expect(row.folderId).toBeNull();
    expect(repo.getSpaceNotesWithoutFolder(teamSpaceId).map((n) => n.id)).toEqual([note.id]);
  });

  // Regression: a note created while browsing a team folder used to be stamped
  // with the private space, stranding it away from the folder holding it.
  it('inherits the space of the folder it is created in', () => {
    const { repo, db } = createMemoryRepository();
    const teamSpaceId = createTeamSpace(db);
    const folder = repo.createFolder('Specs', teamSpaceId);

    const note = repo.createNote('Spec note', '', folder.id);

    const row = noteRow(db, note.id);
    expect(row.folderId).toBe(folder.id);
    expect(row.spaceId).toBe(teamSpaceId);
  });

  it('still defaults to the private space when given neither a folder nor a space', () => {
    const { repo, db } = createMemoryRepository();

    const note = repo.createNote('Personal note', '');

    expect(noteRow(db, note.id).spaceId).toBe(privateSpaceId(db));
  });
});

// The server's folder delete cascades to the notes inside it, so the client
// applies the same cascade instead of re-homing notes into a folder the server
// knows nothing about — journaling everything first so a refusal can undo it.
describe('LocalNotesRepository.deleteFolderCascade', () => {
  const folderRow = (db: TestDb, id: number) =>
    db.select().from(folders).where(eq(folders.id, id)).get()!;

  it('tombstones the folder and every note inside it', () => {
    const { repo, db } = createMemoryRepository();
    const folder = repo.createFolder('Specs');
    const note = repo.createNote('Doomed', '', folder.id);

    repo.deleteFolderCascade(folder.id);

    expect(noteRow(db, note.id).deletedAt).not.toBeNull();
    expect(folderRow(db, folder.id).deletedAt).not.toBeNull();
    expect(folderRow(db, folder.id).pendingSync).toBe(1);
  });

  it('holds the cascaded notes out of the push queue — the folder delete owns them', () => {
    const { repo, db } = createMemoryRepository();
    const folder = repo.createFolder('Specs');
    const note = repo.createNote('Doomed', '', folder.id);
    repo.setNoteClientId(note.id, 'client-1');
    expect(repo.getPendingNotes().map((n) => n.id)).toContain(note.id);

    repo.deleteFolderCascade(folder.id);

    expect(repo.getPendingNotes().map((n) => n.id)).not.toContain(note.id);
    expect(noteRow(db, note.id).pendingSync).toBe(0);
  });

  it('journals the folder and each note so the delete can be undone', () => {
    const { repo, db } = createMemoryRepository();
    const folder = repo.createFolder('Specs');
    const note = repo.createNote('Doomed', '', folder.id);

    repo.deleteFolderCascade(folder.id);

    const journal = db.select().from(folderDeleteJournal).all();
    expect(journal).toHaveLength(2);
    expect(journal.filter((r) => r.entityType === 'folder').map((r) => r.entityId)).toEqual([
      folder.id,
    ]);
    expect(journal.filter((r) => r.entityType === 'note').map((r) => r.entityId)).toEqual([
      note.id,
    ]);
  });

  it("leaves an already-deleted note out of the cascade — that tombstone is the user's own", () => {
    const { repo, db } = createMemoryRepository();
    const folder = repo.createFolder('Specs');
    const note = repo.createNote('Already gone', '', folder.id);
    repo.deleteNote(note.id);

    repo.deleteFolderCascade(folder.id);

    expect(
      db
        .select()
        .from(folderDeleteJournal)
        .all()
        .filter((r) => r.entityType === 'note'),
    ).toEqual([]);
  });
});

describe('LocalNotesRepository.finalizeFolderDelete', () => {
  it('purges the folder, its cascaded notes, and the journal', () => {
    const { repo, db } = createMemoryRepository();
    const folder = repo.createFolder('Specs');
    const note = repo.createNote('Doomed', '', folder.id);
    repo.deleteFolderCascade(folder.id);

    repo.finalizeFolderDelete(folder.id);

    expect(db.select().from(notes).where(eq(notes.id, note.id)).get()).toBeUndefined();
    expect(db.select().from(folders).where(eq(folders.id, folder.id)).get()).toBeUndefined();
    expect(db.select().from(folderDeleteJournal).all()).toEqual([]);
  });
});

describe('LocalNotesRepository.revertFolderDelete', () => {
  it('puts the folder and its notes back exactly as they were', () => {
    const { repo, db } = createMemoryRepository();
    const folder = repo.createFolder('Specs');
    const note = repo.createNote('Survivor', '', folder.id);
    repo.setNoteClientId(note.id, 'client-1');
    const pendingBefore = noteRow(db, note.id).pendingSync;
    repo.deleteFolderCascade(folder.id);

    repo.revertFolderDelete(folder.id);

    const restored = noteRow(db, note.id);
    expect(restored.deletedAt).toBeNull();
    expect(restored.pendingSync).toBe(pendingBefore);
    expect(db.select().from(folders).where(eq(folders.id, folder.id)).get()!.deletedAt).toBeNull();
    expect(db.select().from(folderDeleteJournal).all()).toEqual([]);
  });

  it('returns the notes to the push queue', () => {
    const { repo } = createMemoryRepository();
    const folder = repo.createFolder('Specs');
    const note = repo.createNote('Survivor', '', folder.id);
    repo.setNoteClientId(note.id, 'client-1');
    repo.deleteFolderCascade(folder.id);

    repo.revertFolderDelete(folder.id);

    expect(repo.getPendingNotes().map((n) => n.id)).toContain(note.id);
  });
});

describe('LocalNotesRepository held-note pull guard', () => {
  it('reports a held note as owned by the folder delete, and stops once it settles', () => {
    const { repo } = createMemoryRepository();
    const folder = repo.createFolder('Specs');
    const note = repo.createNote('Doomed', '', folder.id);
    repo.setNoteClientId(note.id, 'client-1');
    const remote = remoteNote({ client_note_id: 'client-1' });

    expect(repo.isRemoteNoteHeldByFolderDelete(remote)).toBe(false);
    repo.deleteFolderCascade(folder.id);
    expect(repo.isRemoteNoteHeldByFolderDelete(remote)).toBe(true);
    repo.revertFolderDelete(folder.id);
    expect(repo.isRemoteNoteHeldByFolderDelete(remote)).toBe(false);
  });

  // Without this the pull would apply the server's cascade tombstone (or a newer
  // remote row) over a note revertFolderDelete still has to restore.
  it('applyRemoteNote leaves a held note untouched', () => {
    const { repo, db } = createMemoryRepository();
    const folder = repo.createFolder('Specs');
    const note = repo.createNote('Local title', '', folder.id);
    repo.setNoteClientId(note.id, 'client-1');
    repo.deleteFolderCascade(folder.id);

    repo.applyRemoteNote(
      remoteNote({ client_note_id: 'client-1', title: 'Server title' }),
      noFolder,
    );

    expect(noteRow(db, note.id).title).toBe('Local title');
  });
});

describe('LocalNotesRepository.moveNoteToSpace', () => {
  it('sets space_id to the target, clears folder_id, and marks pending', () => {
    const { repo, db } = createMemoryRepository();
    const teamSpaceId = createTeamSpace(db);
    const folder = repo.createFolder('Personal folder');
    const note = db
      .insert(notes)
      .values({
        title: 'Note',
        content: '',
        folderId: folder.id,
        spaceId: privateSpaceId(db),
        pendingSync: 0,
      })
      .returning()
      .get();

    repo.moveNoteToSpace(note.id, teamSpaceId);

    const after = noteRow(db, note.id);
    expect(after.spaceId).toBe(teamSpaceId);
    expect(after.folderId).toBeNull();
    expect(after.pendingSync).toBe(1);
  });

  it('moving back to Personal targets the private space and also clears folder_id', () => {
    const { repo, db } = createMemoryRepository();
    const teamSpaceId = createTeamSpace(db);
    const note = db
      .insert(notes)
      .values({ title: 'Team note', content: '', spaceId: teamSpaceId, pendingSync: 0 })
      .returning()
      .get();

    repo.moveNoteToSpace(note.id, privateSpaceId(db));

    const after = noteRow(db, note.id);
    expect(after.spaceId).toBe(privateSpaceId(db));
    expect(after.folderId).toBeNull();
    expect(after.pendingSync).toBe(1);
  });

  it('preserves a parked conflict (unlike deleteNote/setNotePrivacy) — the move queues but stays unpushable until the conflict resolves', () => {
    const { repo, db } = createMemoryRepository();
    const teamSpaceId = createTeamSpace(db);
    const note = db
      .insert(notes)
      .values({
        title: 'Conflicted note',
        content: '',
        spaceId: privateSpaceId(db),
        conflictServerNote: JSON.stringify(remoteNote()),
        pendingSync: 0,
      })
      .returning()
      .get();

    repo.moveNoteToSpace(note.id, teamSpaceId);

    const afterMove = noteRow(db, note.id);
    expect(afterMove.spaceId).toBe(teamSpaceId);
    expect(afterMove.folderId).toBeNull();
    expect(afterMove.pendingSync).toBe(1);
    // The park is deliberately NOT cleared — see the comment on moveNoteToSpace: clearing it here
    // would let the next push carry the move on a stale base_updated_at, draw another 409, and
    // re-park right back.
    expect(afterMove.conflictServerNote).toBe(JSON.stringify(remoteNote()));
    expect(repo.getPendingNotes().map((n) => n.id)).not.toContain(note.id);

    // Resolving the conflict (Keep mine) clears the park and makes the queued move pushable,
    // carrying the moved space_id along with it.
    repo.resolveConflictKeepMine(note.id);

    const afterResolve = noteRow(db, note.id);
    expect(afterResolve.conflictServerNote).toBeNull();
    expect(afterResolve.spaceId).toBe(teamSpaceId);
    expect(repo.getPendingNotes().map((n) => n.id)).toContain(note.id);
  });
});

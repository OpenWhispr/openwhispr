import { eq } from 'drizzle-orm';
import { folders, notes } from '@/db/schema';
import type { RemoteNote } from '@/data/types';
import { createMemoryRepository, type TestDb } from './testDb';

const createMeeting = (db: TestDb, over: Record<string, unknown> = {}) =>
  db
    .insert(notes)
    .values({ title: 'Meeting', content: '', noteType: 'meeting', diarizationEnabled: 1, ...over })
    .returning()
    .get();

const remoteNote = (over: Partial<RemoteNote> = {}): RemoteNote => ({
  id: 'srv-1',
  client_note_id: 'client-1',
  title: 'Original title',
  content: 'Original content',
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
const noFolder = (): number | null => null;

function noteRow(db: TestDb, id: number) {
  return db.select().from(notes).where(eq(notes.id, id)).get()!;
}

describe('LocalNotesRepository.markNotePushed — cloud_updated_at', () => {
  it('seeds cloud_updated_at from the server updated_at (covers both create and update callers)', () => {
    const { repo, db } = createMemoryRepository();
    const local = repo.createNote('Title', 'Content');

    repo.markNotePushed(repo.getNoteById(local.id)!, 'remote-note-1', '2026-08-24T09:00:00.000Z');

    const row = noteRow(db, local.id);
    expect(row.cloudUpdatedAt).toBe('2026-08-24T09:00:00.000Z');
    expect(row.remoteId).toBe('remote-note-1');
    expect(row.pendingSync).toBe(0);
  });
});

describe('LocalNotesRepository.applyRemoteNote — cloud_updated_at on clean applies', () => {
  it('sets cloud_updated_at when inserting a brand-new remote note', () => {
    const { repo } = createMemoryRepository();
    repo.applyRemoteNote(remoteNote({ updated_at: '2026-08-24T10:00:00.000Z' }), noFolder);

    const [note] = repo.getAllNotes();
    expect(note.cloudUpdatedAt).toBe('2026-08-24T10:00:00.000Z');
  });

  it('sets cloud_updated_at when updating an existing clean note', () => {
    const { repo } = createMemoryRepository();
    repo.applyRemoteNote(remoteNote({ updated_at: '2026-08-24T10:00:00.000Z' }), noFolder);
    const [note] = repo.getAllNotes();

    repo.applyRemoteNote(
      remoteNote({ title: 'Updated', updated_at: '2026-08-24T11:00:00.000Z' }),
      noFolder,
    );

    const after = repo.getNoteById(note.id);
    expect(after?.cloudUpdatedAt).toBe('2026-08-24T11:00:00.000Z');
  });

  it('does not set cloud_updated_at when the apply is skipped by the local-pending guard', () => {
    const { repo, db } = createMemoryRepository();
    const local = repo.createNote('Local edit', 'x');
    // createNote leaves pendingSync=1 with no remoteId/clientNoteId match target,
    // but give it a client_note_id so the incoming remote row matches it.
    db.update(notes).set({ clientNoteId: 'client-1' }).where(eq(notes.id, local.id)).run();

    repo.applyRemoteNote(remoteNote({ updated_at: '2026-08-24T10:00:00.000Z' }), noFolder);

    const after = noteRow(db, local.id);
    expect(after.pendingSync).toBe(1);
    expect(after.cloudUpdatedAt).toBeNull();
  });
});

describe('LocalNotesRepository.getPendingNotes — conflict exclusion', () => {
  it('excludes a note parked in conflict even though pendingSync is still 1', () => {
    const { repo, db } = createMemoryRepository();
    const local = repo.createNote('Title', 'Content');
    expect(repo.getPendingNotes().map((n) => n.id)).toContain(local.id);

    repo.parkNoteConflict(local.id, remoteNote({ id: 'srv-1' }));

    const pending = repo.getPendingNotes();
    expect(pending.map((n) => n.id)).not.toContain(local.id);
    // pendingSync itself is untouched by parking — only the query excludes it.
    expect(noteRow(db, local.id).pendingSync).toBe(1);
  });
});

describe('LocalNotesRepository.parkNoteConflict', () => {
  it('stores the server note JSON without touching pendingSync', () => {
    const { repo, db } = createMemoryRepository();
    const local = repo.createNote('Title', 'Content');
    const server = remoteNote({ id: 'srv-1', title: 'Server title' });

    repo.parkNoteConflict(local.id, server);

    const row = noteRow(db, local.id);
    expect(row.pendingSync).toBe(1);
    expect(JSON.parse(row.conflictServerNote!)).toEqual(server);
  });
});

describe('LocalNotesRepository.applyRemoteNote — parked-conflict pull guard', () => {
  it('does not clear the conflict or touch note content while parked', () => {
    const { repo, db } = createMemoryRepository();
    const local = repo.createNote('My local edit', 'my content');
    db.update(notes).set({ clientNoteId: 'client-1' }).where(eq(notes.id, local.id)).run();
    const server = remoteNote({
      id: 'srv-1',
      title: 'Server title',
      updated_at: '2026-08-24T10:00:00.000Z',
    });
    repo.parkNoteConflict(local.id, server);

    // Same updated_at arrives again on pull — must not overwrite local content
    // or clear the parked conflict.
    repo.applyRemoteNote(server, noFolder);

    const row = noteRow(db, local.id);
    expect(row.title).toBe('My local edit');
    expect(row.content).toBe('my content');
    expect(row.pendingSync).toBe(1);
    expect(JSON.parse(row.conflictServerNote!)).toEqual(server);
  });

  it('refreshes the stashed conflict copy only when the incoming updated_at differs', () => {
    const { repo, db } = createMemoryRepository();
    const local = repo.createNote('My local edit', 'my content');
    db.update(notes).set({ clientNoteId: 'client-1' }).where(eq(notes.id, local.id)).run();
    const original = remoteNote({
      id: 'srv-1',
      title: 'First server version',
      updated_at: '2026-08-24T10:00:00.000Z',
    });
    repo.parkNoteConflict(local.id, original);

    // Same updated_at, different title (shouldn't happen server-side, but proves
    // the guard keys off updated_at rather than deep-diffing the payload).
    repo.applyRemoteNote(
      remoteNote({
        id: 'srv-1',
        title: 'Should not stick',
        updated_at: '2026-08-24T10:00:00.000Z',
      }),
      noFolder,
    );
    let stored = JSON.parse(noteRow(db, local.id).conflictServerNote!);
    expect(stored.title).toBe('First server version');

    // A newer updated_at must replace the stashed copy.
    const newer = remoteNote({
      id: 'srv-1',
      title: 'Newer server version',
      updated_at: '2026-08-24T12:00:00.000Z',
    });
    repo.applyRemoteNote(newer, noFolder);
    stored = JSON.parse(noteRow(db, local.id).conflictServerNote!);
    expect(stored.title).toBe('Newer server version');
    expect(stored.updated_at).toBe('2026-08-24T12:00:00.000Z');
    // Local content/pendingSync remain untouched throughout.
    const row = noteRow(db, local.id);
    expect(row.title).toBe('My local edit');
    expect(row.pendingSync).toBe(1);
  });
});

describe('LocalNotesRepository.resolveConflictKeepMine', () => {
  it('clears the conflict, adopts the server updated_at as the new base, and keeps pendingSync', () => {
    const { repo, db } = createMemoryRepository();
    const local = repo.createNote('My local edit', 'my content');
    const server = remoteNote({ id: 'srv-1', updated_at: '2026-08-24T12:00:00.000Z' });
    repo.parkNoteConflict(local.id, server);

    repo.resolveConflictKeepMine(local.id);

    const row = noteRow(db, local.id);
    expect(row.conflictServerNote).toBeNull();
    expect(row.cloudUpdatedAt).toBe('2026-08-24T12:00:00.000Z');
    expect(row.pendingSync).toBe(1);
    // Local content is untouched — "keep mine" means the edit survives as-is.
    expect(row.title).toBe('My local edit');
    expect(row.content).toBe('my content');
  });

  it('is a no-op when the note has no parked conflict', () => {
    const { repo, db } = createMemoryRepository();
    const local = repo.createNote('Title', 'Content');
    repo.markNotePushed(repo.getNoteById(local.id)!, 'remote-note-1', '2026-08-24T09:00:00.000Z');

    repo.resolveConflictKeepMine(local.id);

    const row = noteRow(db, local.id);
    expect(row.cloudUpdatedAt).toBe('2026-08-24T09:00:00.000Z');
    expect(row.pendingSync).toBe(0);
  });
});

describe('LocalNotesRepository.resolveConflictUseServer', () => {
  it('applies the stored server note over local, clears the conflict, and clears pendingSync', () => {
    const { repo, db } = createMemoryRepository();
    const local = repo.createNote('My local edit', 'my content');
    const server = remoteNote({
      id: 'srv-1',
      title: 'Server title',
      content: 'Server content',
      updated_at: '2026-08-24T12:00:00.000Z',
    });
    repo.parkNoteConflict(local.id, server);

    repo.resolveConflictUseServer(local.id);

    const row = noteRow(db, local.id);
    expect(row.title).toBe('Server title');
    expect(row.content).toBe('Server content');
    expect(row.remoteId).toBe('srv-1');
    expect(row.cloudUpdatedAt).toBe('2026-08-24T12:00:00.000Z');
    expect(row.conflictServerNote).toBeNull();
    expect(row.pendingSync).toBe(0);
  });

  it('bypasses the pendingSync guard (the row stays pendingSync=1 from parking, but is still applied)', () => {
    const { repo, db } = createMemoryRepository();
    const local = repo.createNote('My local edit', 'my content');
    const server = remoteNote({
      id: 'srv-1',
      title: 'Server title',
      updated_at: '2026-08-24T12:00:00.000Z',
    });
    repo.parkNoteConflict(local.id, server);
    expect(noteRow(db, local.id).pendingSync).toBe(1);

    repo.resolveConflictUseServer(local.id);

    expect(noteRow(db, local.id).title).toBe('Server title');
  });

  it('resolves the server folder_id through the local folders table', () => {
    const { repo, db } = createMemoryRepository();
    const local = repo.createNote('My local edit', 'my content');
    const folder = db
      .insert(folders)
      .values({ name: 'Work', remoteId: 'remote-folder-9' })
      .returning()
      .get();
    const server = remoteNote({
      id: 'srv-1',
      folder_id: 'remote-folder-9',
      updated_at: '2026-08-24T12:00:00.000Z',
    });
    repo.parkNoteConflict(local.id, server);

    repo.resolveConflictUseServer(local.id);

    expect(noteRow(db, local.id).folderId).toBe(folder.id);
  });

  it('is a no-op when the note has no parked conflict', () => {
    const { repo, db } = createMemoryRepository();
    const local = repo.createNote('Title', 'Content');
    repo.markNotePushed(repo.getNoteById(local.id)!, 'remote-note-1', '2026-08-24T09:00:00.000Z');

    repo.resolveConflictUseServer(local.id);

    const row = noteRow(db, local.id);
    expect(row.title).toBe('Title');
    expect(row.pendingSync).toBe(0);
  });
});

describe('LocalNotesRepository.listConflictedNotes', () => {
  it('returns id/title/parsed conflict payload for parked rows only', () => {
    const { repo } = createMemoryRepository();
    const conflicted = repo.createNote('Conflicted note', 'x');
    const clean = repo.createNote('Clean note', 'y');
    repo.markNotePushed(
      repo.getNoteById(clean.id)!,
      'remote-note-clean',
      '2026-08-24T09:00:00.000Z',
    );
    const server = remoteNote({ id: 'srv-1', title: 'Server title' });
    repo.parkNoteConflict(conflicted.id, server);

    const result = repo.listConflictedNotes();

    expect(result).toEqual([
      { id: conflicted.id, title: 'Conflicted note', conflictServerNote: server },
    ]);
  });

  it('returns an empty list when nothing is parked', () => {
    const { repo } = createMemoryRepository();
    repo.createNote('Title', 'Content');

    expect(repo.listConflictedNotes()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Fix round 1 — code review findings on the initial Task 5 implementation.
// ---------------------------------------------------------------------------

describe('LocalNotesRepository.resolveConflictUseServer — tombstone (fix round 1, finding 1)', () => {
  it('hard-deletes the local row instead of resurrecting a zombie when the stashed conflict is a tombstone', () => {
    const { repo, db } = createMemoryRepository();
    const local = repo.createNote('My local edit', 'my content');
    db.update(notes).set({ clientNoteId: 'client-1' }).where(eq(notes.id, local.id)).run();
    const live = remoteNote({
      id: 'srv-1',
      title: 'Live version',
      updated_at: '2026-08-24T10:00:00.000Z',
    });
    repo.parkNoteConflict(local.id, live);

    // Someone deletes the note on another device while this one stays parked.
    // The pull-side refresh guard (chosen semantics — see report) stashes the
    // tombstone as the latest conflict copy rather than silently discarding
    // the local edit, so the banner can honestly show "deleted elsewhere".
    const tombstone = remoteNote({
      id: 'srv-1',
      deleted_at: '2026-08-24T11:00:00.000Z',
      updated_at: '2026-08-24T11:00:00.000Z',
    });
    repo.applyRemoteNote(tombstone, noFolder);
    const stashed = JSON.parse(noteRow(db, local.id).conflictServerNote!);
    expect(stashed.deleted_at).toBe('2026-08-24T11:00:00.000Z');
    // Local row must still be alive and untouched at this point.
    expect(repo.getNoteById(local.id)).not.toBeNull();

    // "Use server's copy" on a tombstone means accepting the deletion, not
    // reviving the note locally with a remoteId pointing at a gone server row.
    repo.resolveConflictUseServer(local.id);

    expect(repo.getNoteById(local.id)).toBeNull();
  });

  it('still applies normally when the stashed conflict is a live (non-tombstone) note', () => {
    const { repo } = createMemoryRepository();
    const local = repo.createNote('My local edit', 'my content');
    const server = remoteNote({
      id: 'srv-1',
      title: 'Server title',
      updated_at: '2026-08-24T12:00:00.000Z',
    });
    repo.parkNoteConflict(local.id, server);

    repo.resolveConflictUseServer(local.id);

    expect(repo.getNoteById(local.id)?.title).toBe('Server title');
  });
});

describe('LocalNotesRepository.deleteNote — clears a parked conflict (fix round 1, finding 2)', () => {
  it('lets a local delete push instead of wedging behind the conflict exclusion', () => {
    const { repo, db } = createMemoryRepository();
    const local = repo.createNote('Title', 'Content');
    repo.markNotePushed(repo.getNoteById(local.id)!, 'remote-note-1', '2026-08-24T09:00:00.000Z');
    repo.parkNoteConflict(local.id, remoteNote({ id: 'remote-note-1' }));
    // Parked: excluded from the push queue, as getPendingNotes — conflict
    // exclusion already covers.
    expect(repo.getPendingNotes().map((n) => n.id)).not.toContain(local.id);

    repo.deleteNote(local.id);

    const row = noteRow(db, local.id);
    expect(row.deletedAt).not.toBeNull();
    expect(row.pendingSync).toBe(1);
    expect(row.conflictServerNote).toBeNull();
    // The delete now rejoins the push queue instead of vanishing locally forever.
    expect(repo.getPendingNotes().map((n) => n.id)).toContain(local.id);
  });
});

describe('LocalNotesRepository.setNotePrivacy — clears a parked conflict (fix round 1, finding 2)', () => {
  it('keeps a live cloud identity recoverable without replacing private content', () => {
    const { repo } = createMemoryRepository();
    const local = repo.createNote('Private title', 'Private content');
    repo.setNoteClientId(local.id, 'client-1');
    repo.setNotePrivacy(local.id, true);

    repo.applyRemoteNote(remoteNote(), noFolder);

    expect(repo.getNoteById(local.id)).toMatchObject({
      title: 'Private title',
      content: 'Private content',
      isPrivate: 1,
      pendingSync: 0,
      remoteId: 'srv-1',
      clientNoteId: 'client-1',
    });
    expect(repo.getPrivateNotesPendingDeletion().map((note) => note.id)).toContain(local.id);
  });

  it('settles cloud deletion on a tombstone without deleting the private note', () => {
    const { repo } = createMemoryRepository();
    const local = repo.createNote('Private title', 'Private content');
    repo.setNoteClientId(local.id, 'client-1');
    repo.markNotePushed(repo.getNoteById(local.id)!, 'srv-1', '2026-08-24T09:00:00.000Z');
    repo.setNotePrivacy(local.id, true);

    repo.applyRemoteNote(remoteNote({ deleted_at: '2026-08-24T10:00:00.000Z' }), noFolder);

    expect(repo.getNoteById(local.id)).toMatchObject({
      title: 'Private title',
      content: 'Private content',
      isPrivate: 1,
      deletedAt: null,
      pendingSync: 0,
      remoteId: null,
      clientNoteId: null,
      cloudUpdatedAt: null,
    });
    expect(repo.getPrivateNotesPendingDeletion()).toEqual([]);
  });

  it('retains deletion identity when a tombstone only reports lost access', () => {
    const { repo } = createMemoryRepository();
    const local = repo.createNote('Private title', 'Private content');
    repo.setNoteClientId(local.id, 'client-1');
    repo.markNotePushed(repo.getNoteById(local.id)!, 'srv-1', '2026-08-24T09:00:00.000Z');
    repo.setNotePrivacy(local.id, true);

    repo.applyRemoteNote(
      remoteNote({ deleted_at: '2026-08-24T10:00:00.000Z', access_removed: true }),
      noFolder,
    );

    expect(repo.getNoteById(local.id)).toMatchObject({
      content: 'Private content',
      isPrivate: 1,
      deletedAt: null,
      remoteId: 'srv-1',
      clientNoteId: 'client-1',
      cloudUpdatedAt: '2026-08-24T09:00:00.000Z',
    });
    expect(repo.getPrivateNotesPendingDeletion().map((note) => note.id)).toContain(local.id);
  });

  it('includes an unacknowledged create in private cloud-deletion recovery', () => {
    const { repo } = createMemoryRepository();
    const pending = repo.createNote('Pending upload', 'Content');
    repo.setNoteClientId(pending.id, 'client-pending');
    repo.setNotePrivacy(pending.id, true);
    const neverUploaded = repo.createNote('Always private', 'Content');
    repo.setNotePrivacy(neverUploaded.id, true);
    const publicNote = repo.createNote('Public', 'Content');
    repo.setNoteClientId(publicNote.id, 'client-public');

    expect(repo.getPrivateNotesPendingDeletion().map((note) => note.id)).toEqual([pending.id]);
  });

  it('republishes under a fresh identity that an old upload acknowledgement cannot overwrite', () => {
    const { repo } = createMemoryRepository();
    const local = repo.createNote('Private title', 'Private content');
    repo.setNoteClientId(local.id, 'client-1');
    repo.markNotePushed(repo.getNoteById(local.id)!, 'srv-1', '2026-08-24T09:00:00.000Z');
    const oldUpload = repo.getNoteById(local.id)!;
    repo.setNotePrivacy(local.id, true);

    repo.setNotePrivacy(local.id, false);
    repo.markNotePushed(oldUpload, 'srv-1', '2026-08-24T11:00:00.000Z');

    const published = repo.getNoteById(local.id)!;
    expect(published).toMatchObject({
      content: 'Private content',
      isPrivate: 0,
      pendingSync: 1,
      remoteId: null,
      cloudUpdatedAt: null,
      clientNoteId: expect.any(String),
    });
    expect(published.clientNoteId).not.toBe('client-1');
    expect(repo.getPrivateNotesPendingDeletion()).toEqual([]);
  });

  it('clears conflictServerNote on going private', () => {
    const { repo, db } = createMemoryRepository();
    const local = repo.createNote('Title', 'Content');
    repo.markNotePushed(repo.getNoteById(local.id)!, 'remote-note-1', '2026-08-24T09:00:00.000Z');
    repo.parkNoteConflict(local.id, remoteNote({ id: 'remote-note-1' }));

    repo.setNotePrivacy(local.id, true);

    const row = noteRow(db, local.id);
    expect(row.isPrivate).toBe(1);
    expect(row.conflictServerNote).toBeNull();
  });

  it('clears conflictServerNote on going public, so the re-publish is not wedged behind the old park', () => {
    const { repo, db } = createMemoryRepository();
    const local = repo.createNote('Title', 'Content');
    repo.markNotePushed(repo.getNoteById(local.id)!, 'remote-note-1', '2026-08-24T09:00:00.000Z');
    repo.parkNoteConflict(local.id, remoteNote({ id: 'remote-note-1' }));

    repo.setNotePrivacy(local.id, false);

    const row = noteRow(db, local.id);
    expect(row.isPrivate).toBe(0);
    expect(row.conflictServerNote).toBeNull();
    expect(row.pendingSync).toBe(1);
    expect(repo.getPendingNotes().map((n) => n.id)).toContain(local.id);
  });
});

describe('LocalNotesRepository.listConflictedNotes — excludes deleted/private rows (fix round 1, finding 2)', () => {
  it('excludes a conflicted row that is soft-deleted or private, defensively', () => {
    const { repo, db } = createMemoryRepository();
    const deletedNote = repo.createNote('Deleted', 'x');
    repo.parkNoteConflict(deletedNote.id, remoteNote({ id: 'srv-1' }));
    // Bypass deleteNote's own clear (tested above) to exercise the query
    // filter itself, defense-in-depth against any other path that could leave
    // a stale park on a deleted/private row.
    db.update(notes)
      .set({ deletedAt: '2026-08-24T00:00:00.000Z' })
      .where(eq(notes.id, deletedNote.id))
      .run();

    const privateNote = repo.createNote('Private', 'y');
    repo.parkNoteConflict(privateNote.id, remoteNote({ id: 'srv-2' }));
    db.update(notes).set({ isPrivate: 1 }).where(eq(notes.id, privateNote.id)).run();

    expect(repo.listConflictedNotes()).toEqual([]);
  });
});

describe('LocalNotesRepository.markNotePushed — cloudUpdatedAt opt-out (fix round 1, finding 3)', () => {
  it('leaves cloud_updated_at null when the caller explicitly passes null (older backend, no server updated_at)', () => {
    const { repo, db } = createMemoryRepository();
    const local = repo.createNote('Title', 'Content');

    // 3rd arg still seeds local bookkeeping (updatedAt) from the caller's
    // fallback; 4th arg opts cloudUpdatedAt out of that same fallback.
    repo.markNotePushed(
      repo.getNoteById(local.id)!,
      'remote-note-1',
      '2026-08-24T09:00:00.000Z',
      null,
    );

    const row = noteRow(db, local.id);
    expect(row.updatedAt).toBe('2026-08-24T09:00:00.000Z');
    expect(row.cloudUpdatedAt).toBeNull();
    expect(row.remoteId).toBe('remote-note-1');
    expect(row.pendingSync).toBe(0);
  });

  it('a row seeded with a null base omits base_updated_at forever after (never false-409-parks)', () => {
    // This is the other half of the fix: proven at the pushNotes.ts level in
    // pushNotes.test.ts ("omits base_updated_at on update when the row has no
    // cloud_updated_at"). Here we just confirm the repository-side precondition
    // that test relies on: markNotePushed(..., null) really does leave the
    // column null, not the local-clock fallback.
    const { repo, db } = createMemoryRepository();
    const local = repo.createNote('Title', 'Content');
    repo.markNotePushed(
      repo.getNoteById(local.id)!,
      'remote-note-1',
      '2026-08-24T09:00:00.000Z',
      null,
    );

    expect(noteRow(db, local.id).cloudUpdatedAt).toBeNull();
  });
});

describe('LocalNotesRepository.resolveConflictKeepMine — corrupt stashed JSON (fix round 1, finding 4)', () => {
  it('clears the park even when the stashed JSON fails to parse, so the row rejoins getPendingNotes', () => {
    const { repo, db } = createMemoryRepository();
    const local = repo.createNote('My local edit', 'my content');
    db.update(notes).set({ conflictServerNote: 'not-json{{{' }).where(eq(notes.id, local.id)).run();
    expect(repo.getPendingNotes().map((n) => n.id)).not.toContain(local.id);

    repo.resolveConflictKeepMine(local.id);

    const row = noteRow(db, local.id);
    expect(row.conflictServerNote).toBeNull();
    expect(row.pendingSync).toBe(1);
    expect(repo.getPendingNotes().map((n) => n.id)).toContain(local.id);
    // Local content untouched — keep-mine never depended on the stashed data.
    expect(row.title).toBe('My local edit');
  });
});

describe('LocalNotesRepository.listConflictedNotes — corrupt stashed JSON (fix round 1, finding 4)', () => {
  it('surfaces a row with unparseable stashed JSON as conflictServerNote: null, rather than hiding it', () => {
    const { repo, db } = createMemoryRepository();
    const local = repo.createNote('Corrupt row', 'x');
    db.update(notes).set({ conflictServerNote: 'not-json{{{' }).where(eq(notes.id, local.id)).run();

    expect(repo.listConflictedNotes()).toEqual([
      { id: local.id, title: 'Corrupt row', conflictServerNote: null },
    ]);
  });
});

describe('LocalNotesRepository.resolveConflictUseServer — dirty transcript (fix round 1, finding 5)', () => {
  it('rebuilds a dirty local transcript from the server copy when the server carries one (dirty rows cleared as a side effect)', () => {
    const { repo, db } = createMemoryRepository();
    const note = createMeeting(db);
    repo.replaceSegments(note.id, [
      { noteId: note.id, text: 'my dirty local edit', startMs: 0, endMs: 0, sortOrder: 0 },
    ]);
    expect(repo.hasDirtyTranscript(note.id)).toBe(true);

    const serverTranscript = JSON.stringify([
      { text: 'Server line.', source: 'mic', timestamp: 1000 },
    ]);
    const server = remoteNote({
      id: 'srv-1',
      transcript: serverTranscript,
      updated_at: '2026-08-24T12:00:00.000Z',
    });
    repo.parkNoteConflict(note.id, server);

    repo.resolveConflictUseServer(note.id);

    const segments = repo.getSegments(note.id);
    expect(segments).toHaveLength(1);
    expect(segments[0].text).toBe('Server line.');
    expect(segments.every((s) => s.pendingSync === 0)).toBe(true);
    expect(repo.hasDirtyTranscript(note.id)).toBe(false);
    // The user's "use server" choice must not be undone by the note resurfacing
    // in the push queue via the dirty-child-row path.
    expect(repo.getPendingNotes().map((n) => n.id)).not.toContain(note.id);
  });

  it('clears dirty transcript flags even when the server copy carries no transcript at all', () => {
    const { repo, db } = createMemoryRepository();
    const note = createMeeting(db);
    repo.replaceSegments(note.id, [
      { noteId: note.id, text: 'my dirty local edit', startMs: 0, endMs: 0, sortOrder: 0 },
    ]);
    expect(repo.hasDirtyTranscript(note.id)).toBe(true);

    const server = remoteNote({
      id: 'srv-1',
      transcript: null,
      updated_at: '2026-08-24T12:00:00.000Z',
    });
    repo.parkNoteConflict(note.id, server);

    repo.resolveConflictUseServer(note.id);

    // Content is untouched — there's nothing to rebuild from — but the dirty
    // flag must not survive: otherwise this note resurfaces in getPendingNotes
    // and pushes the discarded local transcript right back over the server's
    // chosen state.
    const segments = repo.getSegments(note.id);
    expect(segments).toHaveLength(1);
    expect(segments[0].text).toBe('my dirty local edit');
    expect(segments.every((s) => s.pendingSync === 0)).toBe(true);
    expect(repo.hasDirtyTranscript(note.id)).toBe(false);
    expect(repo.getPendingNotes().map((n) => n.id)).not.toContain(note.id);
  });
});

import { eq } from 'drizzle-orm';
import { folders, notes, spaces, syncState } from '@/db/schema';
import { randomUUID } from '@/lib/uuid';
import { createMemoryRepository, type TestDb } from './testDb';

// Requirement 4 (Task 9): account-switch wipe must clear every per-account
// artifact Tasks 4-8 added — team spaces, team cursors, the team-spaces
// capability flag, park keys, and per-note conflict state — while leaving the
// device-local private space intact (getPrivateSpaceId() must keep
// resolving; see the class-level comment on LocalNotesRepository).

const privateSpaceRow = (db: TestDb) =>
  db.select().from(spaces).where(eq(spaces.kind, 'private')).get()!;

const createTeamSpace = (db: TestDb, name = 'Engineering', cloudSpaceId = 'cloud-space-1') =>
  db
    .insert(spaces)
    .values({ clientSpaceId: randomUUID(), cloudSpaceId, kind: 'team', name })
    .returning()
    .get().id;

describe('LocalNotesRepository.wipeAllSyncableData', () => {
  it('leaves the private space row exactly as it was — same id, still resolvable', () => {
    const { repo, db } = createMemoryRepository();
    const before = privateSpaceRow(db);

    repo.wipeAllSyncableData();

    const after = privateSpaceRow(db);
    expect(after.id).toBe(before.id);
    expect(after.deletedAt).toBeNull();
    // A subsequent local write still resolves into it without throwing.
    const folder = repo.createFolder('New');
    expect(folder.spaceId).toBe(before.id);
  });

  it('deletes every kind=team space', () => {
    const { repo, db } = createMemoryRepository();
    createTeamSpace(db, 'Engineering', 'cloud-space-1');
    createTeamSpace(db, 'Marketing', 'cloud-space-2');
    expect(db.select().from(spaces).where(eq(spaces.kind, 'team')).all()).toHaveLength(2);

    repo.wipeAllSyncableData();

    expect(db.select().from(spaces).where(eq(spaces.kind, 'team')).all()).toEqual([]);
    // Exactly the private space remains.
    expect(db.select().from(spaces).all()).toHaveLength(1);
    expect(db.select().from(spaces).all()[0]!.kind).toBe('private');
  });

  it('deletes a team space even if it was already soft-deleted (revoked) before the switch', () => {
    const { repo, db } = createMemoryRepository();
    const teamId = createTeamSpace(db);
    db.update(spaces)
      .set({ deletedAt: '2026-08-01T00:00:00.000Z' })
      .where(eq(spaces.id, teamId))
      .run();

    repo.wipeAllSyncableData();

    expect(db.select().from(spaces).where(eq(spaces.id, teamId)).all()).toEqual([]);
  });

  it('clears every sync_state row — team cursors, the team-spaces capability flag, park keys, and per-user flags alike', () => {
    const { repo, db } = createMemoryRepository();
    const keys = [
      'sync.user_id',
      'notes.last_sync_at',
      'folders.last_sync_at',
      'notes.team.last_sync_at',
      'notes.team.last_sync_id',
      'folders.team.last_sync_at',
      'team_spaces_capability',
      'notes.team.parked_row',
      'folders.team.parked_row',
      'initial_backfill_done.previous-user',
    ];
    for (const key of keys) repo.setSyncState(key, 'x');
    expect(db.select().from(syncState).all()).toHaveLength(keys.length);

    repo.wipeAllSyncableData();

    expect(db.select().from(syncState).all()).toEqual([]);
    for (const key of keys) expect(repo.getSyncState(key)).toBeNull();
  });

  it('clears per-note conflict state — the parked note (and its stash) is gone with the rest of notes', () => {
    const { repo, db } = createMemoryRepository();
    const inserted = db
      .insert(notes)
      .values({
        title: 'Parked',
        content: 'x',
        pendingSync: 1,
        conflictServerNote: JSON.stringify({ id: 'srv-1', updated_at: '2026-08-24T10:00:00.000Z' }),
      })
      .returning()
      .get();
    expect(repo.listConflictedNotes().map((n) => n.id)).toContain(inserted.id);

    repo.wipeAllSyncableData();

    expect(db.select().from(notes).all()).toEqual([]);
    expect(repo.listConflictedNotes()).toEqual([]);
  });

  it('still clears notes/folders in every space, private and team alike', () => {
    const { repo, db } = createMemoryRepository();
    const teamId = createTeamSpace(db);
    repo.createFolder('Private folder');
    repo.createNote('Private note', '');
    db.insert(folders).values({ name: 'Team folder', spaceId: teamId }).run();
    db.insert(notes).values({ title: 'Team note', content: '', spaceId: teamId }).run();

    repo.wipeAllSyncableData();

    expect(db.select().from(folders).all()).toEqual([]);
    expect(db.select().from(notes).all()).toEqual([]);
  });
});

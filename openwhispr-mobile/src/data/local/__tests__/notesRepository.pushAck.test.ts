import { eq } from 'drizzle-orm';
import { notes } from '@/db/schema';
import { createMemoryRepository } from './testDb';

const SERVER_UPDATED_AT = '2026-09-07T12:00:00.000Z';

// A push acknowledgement settles the row that was serialized into the request,
// not whatever the row has become since. The user can keep editing (or delete)
// while the request is in flight, and that work must stay queued — otherwise
// the next pull would happily overwrite it with the server's older copy.
describe('LocalNotesRepository.markNotePushed — in-flight edits', () => {
  it('settles a row that is unchanged since it was pushed', () => {
    const { repo, db } = createMemoryRepository();
    const pushed = repo.createNote('Standup', 'notes');

    repo.markNotePushed(pushed, 'srv-1', SERVER_UPDATED_AT);

    const saved = db.select().from(notes).where(eq(notes.id, pushed.id)).get()!;
    expect(saved.pendingSync).toBe(0);
    expect(saved.remoteId).toBe('srv-1');
    expect(saved.updatedAt).toBe(SERVER_UPDATED_AT);
    expect(saved.cloudUpdatedAt).toBe(SERVER_UPDATED_AT);
  });

  it('keeps a row queued when it was edited while the push was in flight', () => {
    const { repo, db } = createMemoryRepository();
    const pushed = repo.createNote('Standup', 'notes');
    repo.updateNote(pushed.id, { title: 'Sprint planning' });
    const editedAt = repo.getNoteById(pushed.id)!.updatedAt;

    repo.markNotePushed(pushed, 'srv-1', SERVER_UPDATED_AT);

    const saved = db.select().from(notes).where(eq(notes.id, pushed.id)).get()!;
    expect(saved.pendingSync).toBe(1);
    expect(saved.title).toBe('Sprint planning');
    expect(saved.updatedAt).toBe(editedAt);
    // The server row now exists at this revision, so the follow-up push must
    // PATCH it with this base rather than re-create it.
    expect(saved.remoteId).toBe('srv-1');
    expect(saved.cloudUpdatedAt).toBe(SERVER_UPDATED_AT);
  });

  it('keeps a delete queued when the note was deleted while the push was in flight', () => {
    const { repo, db } = createMemoryRepository();
    const pushed = repo.createNote('Standup', 'notes');
    repo.deleteNote(pushed.id);

    repo.markNotePushed(pushed, 'srv-1', SERVER_UPDATED_AT);

    const saved = db.select().from(notes).where(eq(notes.id, pushed.id)).get()!;
    expect(saved.deletedAt).not.toBeNull();
    expect(saved.pendingSync).toBe(1);
    expect(saved.remoteId).toBe('srv-1');
  });

  it('ignores the ack when the row changed identity while the push was in flight', () => {
    const { repo, db } = createMemoryRepository();
    const pushed = repo.createNote('Standup', 'notes');
    repo.forkNoteToPrivate(pushed.id);

    repo.markNotePushed(pushed, 'srv-1', SERVER_UPDATED_AT);

    const saved = db.select().from(notes).where(eq(notes.id, pushed.id)).get()!;
    expect(saved.remoteId).toBeNull();
    expect(saved.cloudUpdatedAt).toBeNull();
    expect(saved.pendingSync).toBe(1);
  });
});

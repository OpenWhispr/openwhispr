import { eq } from 'drizzle-orm';
import {
  dictionaryEntries,
  folders,
  notes,
  snippets,
  speakers,
  transcriptSegments,
} from '@/db/schema';
import { createMemoryRepository } from './testDb';

// When an anonymous onboarding session links to an account the server moves
// billing only; every remote id on the device still names a row owned by the
// anonymous user. Linking must forget those ids and re-dirty the rows so the
// next push re-creates them under the account rather than PATCHing ids it no
// longer owns.
describe('LocalNotesRepository.dropRemoteIdsForAccountLink', () => {
  it('forgets remote ids and re-dirties every syncable row kind', () => {
    const { repo, db } = createMemoryRepository();
    const folder = repo.createFolder('Ideas');
    const note = repo.createNote('Standup', 'notes', folder.id);
    db.update(folders)
      .set({ remoteId: 'srv-folder', pendingSync: 0 })
      .where(eq(folders.id, folder.id))
      .run();
    db.update(notes)
      .set({
        remoteId: 'srv-note',
        cloudUpdatedAt: '2026-09-01T00:00:00.000Z',
        ownerUserId: 'anon-user',
        updatedByUserId: 'anon-user',
        pendingSync: 0,
      })
      .where(eq(notes.id, note.id))
      .run();
    db.insert(transcriptSegments)
      .values({
        noteId: note.id,
        startMs: 0,
        endMs: 10,
        text: 'hi',
        remoteId: 'srv-seg',
        pendingSync: 0,
      })
      .run();
    db.insert(speakers)
      .values({ noteId: note.id, speakerLabel: 'S1', remoteId: 'srv-spk', pendingSync: 0 })
      .run();
    db.insert(dictionaryEntries)
      .values({ word: 'Whispr', remoteId: 'srv-dict', pendingSync: 0 })
      .run();
    db.insert(snippets)
      .values({
        trigger: 'brb',
        replacement: 'be right back',
        remoteId: 'srv-snip',
        pendingSync: 0,
      })
      .run();

    repo.dropRemoteIdsForAccountLink();

    const savedNote = db.select().from(notes).where(eq(notes.id, note.id)).get()!;
    expect(savedNote.remoteId).toBeNull();
    expect(savedNote.cloudUpdatedAt).toBeNull();
    expect(savedNote.ownerUserId).toBeNull();
    expect(savedNote.updatedByUserId).toBeNull();
    expect(savedNote.pendingSync).toBe(1);
    // Identity survives: the same client id re-creates the note, not a fork.
    expect(savedNote.clientNoteId).toBe(note.clientNoteId);

    for (const rows of [
      db.select().from(folders).all(),
      db.select().from(transcriptSegments).all(),
      db.select().from(speakers).all(),
      db.select().from(dictionaryEntries).all(),
      db.select().from(snippets).all(),
    ]) {
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        expect(row.remoteId).toBeNull();
        expect(row.pendingSync).toBe(1);
      }
    }
  });
});

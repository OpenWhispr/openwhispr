jest.mock('expo-file-system/legacy', () => ({
  documentDirectory: 'file:///app/documents/',
  deleteAsync: jest.fn().mockResolvedValue(undefined),
}));
import { eq } from 'drizzle-orm';
import { notes } from '@/db/schema';
import { createMemoryRepository, type TestDb } from './testDb';

const createMeeting = (db: TestDb) =>
  db
    .insert(notes)
    .values({ title: 'Meeting', content: '', noteType: 'meeting', pendingSync: 0 })
    .returning()
    .get();

const segment = (text: string, sortOrder: number) => ({
  noteId: 0,
  text,
  startMs: sortOrder * 1000,
  endMs: sortOrder * 1000 + 500,
  speakerLabel: null,
  sortOrder,
});

const notePendingSync = (db: TestDb, noteId: number): number | undefined =>
  db.select({ pendingSync: notes.pendingSync }).from(notes).where(eq(notes.id, noteId)).get()
    ?.pendingSync;

describe('LocalNotesRepository.appendSegments', () => {
  it('appends without replacing earlier segments', () => {
    const { repo, db } = createMemoryRepository();
    const note = createMeeting(db);

    repo.appendSegments(note.id, [segment('First.', 0)]);
    repo.appendSegments(note.id, [segment('Second.', 1)]);

    const rows = repo.getSegments(note.id);
    expect(rows.map((row) => row.text)).toEqual(['First.', 'Second.']);
    expect(rows.every((row) => row.pendingSync === 1)).toBe(true);
  });

  it('does not mark the note for sync', () => {
    const { repo, db } = createMemoryRepository();
    const note = createMeeting(db);

    repo.appendSegments(note.id, [segment('First.', 0)]);

    expect(notePendingSync(db, note.id)).toBe(0);
  });

  it('is replaced by a later replaceSegments', () => {
    const { repo, db } = createMemoryRepository();
    const note = createMeeting(db);
    repo.appendSegments(note.id, [segment('Live one.', 0), segment('Live two.', 1)]);

    repo.replaceSegments(note.id, [segment('Final.', 0)]);

    expect(repo.getSegments(note.id).map((row) => row.text)).toEqual(['Final.']);
    expect(notePendingSync(db, note.id)).toBe(1);
  });
});

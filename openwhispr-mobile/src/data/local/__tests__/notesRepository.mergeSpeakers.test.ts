import { eq } from 'drizzle-orm';
import { notes, speakers, transcriptSegments } from '@/db/schema';
import type { Speaker } from '@/data/types';
import { createMemoryRepository, type TestDb } from './testDb';

const createMeeting = (db: TestDb, title = 'Meeting') =>
  db
    .insert(notes)
    .values({ title, content: '', noteType: 'meeting', diarizationEnabled: 1 })
    .returning()
    .get();

const createSpeaker = (
  db: TestDb,
  values: {
    noteId: number;
    speakerLabel: string;
    displayName?: string | null;
    color?: string | null;
    sortOrder?: number;
  },
): Speaker =>
  db
    .insert(speakers)
    .values({
      noteId: values.noteId,
      speakerLabel: values.speakerLabel,
      displayName: values.displayName ?? null,
      color: values.color ?? null,
      sortOrder: values.sortOrder ?? 0,
    })
    .returning()
    .get();

describe('LocalNotesRepository.mergeSpeakers', () => {
  it('relabels source segments and soft-deletes the source speaker transactionally', () => {
    const { repo, db } = createMemoryRepository();
    const note = createMeeting(db);
    const source = createSpeaker(db, {
      noteId: note.id,
      speakerLabel: 'SPEAKER_00',
      displayName: 'Alice',
      sortOrder: 0,
    });
    const target = createSpeaker(db, {
      noteId: note.id,
      speakerLabel: 'SPEAKER_01',
      displayName: 'Bob',
      color: '#123456',
      sortOrder: 1,
    });
    db.insert(transcriptSegments)
      .values([
        {
          noteId: note.id,
          speakerLabel: source.speakerLabel,
          startMs: 0,
          endMs: 1_000,
          text: 'Hello',
          sortOrder: 0,
        },
        {
          noteId: note.id,
          speakerLabel: target.speakerLabel,
          startMs: 1_000,
          endMs: 2_000,
          text: 'Hi',
          sortOrder: 1,
        },
      ])
      .run();

    repo.mergeSpeakers(note.id, source.id, target.id, {
      displayName: 'Bob',
      speakerStatus: 'locked',
      speakerLocked: 1,
      speakerLockSource: 'user',
    });

    expect(repo.getSegments(note.id).map((segment) => segment.speakerLabel)).toEqual([
      'SPEAKER_01',
      'SPEAKER_01',
    ]);
    expect(repo.getSpeakers(note.id).map((speaker) => speaker.id)).toEqual([target.id]);
    expect(repo.getSpeakers(note.id)[0]).toEqual(
      expect.objectContaining({
        displayName: 'Bob',
        color: '#123456',
        speakerStatus: 'locked',
        speakerLocked: 1,
        speakerLockSource: 'user',
      }),
    );

    const deletedSource = db.select().from(speakers).where(eq(speakers.id, source.id)).get();
    expect(deletedSource?.deletedAt).toEqual(expect.any(String));
    expect(deletedSource?.pendingSync).toBe(1);
  });

  it('rejects merging a speaker into itself', () => {
    const { repo, db } = createMemoryRepository();
    const note = createMeeting(db);
    const source = createSpeaker(db, {
      noteId: note.id,
      speakerLabel: 'SPEAKER_00',
      displayName: 'Alice',
    });

    expect(() => repo.mergeSpeakers(note.id, source.id, source.id, {})).toThrow(
      'Cannot merge a speaker into itself',
    );
  });

  it('rejects a missing source speaker', () => {
    const { repo, db } = createMemoryRepository();
    const note = createMeeting(db);
    const target = createSpeaker(db, {
      noteId: note.id,
      speakerLabel: 'SPEAKER_01',
      displayName: 'Bob',
    });

    expect(() => repo.mergeSpeakers(note.id, 999, target.id, {})).toThrow(
      'Source speaker not found',
    );
    expect(repo.getSpeakers(note.id).map((speaker) => speaker.id)).toEqual([target.id]);
  });

  it('rejects a missing target speaker', () => {
    const { repo, db } = createMemoryRepository();
    const note = createMeeting(db);
    const source = createSpeaker(db, {
      noteId: note.id,
      speakerLabel: 'SPEAKER_00',
      displayName: 'Alice',
    });

    expect(() => repo.mergeSpeakers(note.id, source.id, 999, {})).toThrow(
      'Target speaker not found',
    );
    expect(repo.getSpeakers(note.id).map((speaker) => speaker.id)).toEqual([source.id]);
  });

  it('scopes source and target lookup to the requested note', () => {
    const { repo, db } = createMemoryRepository();
    const note = createMeeting(db, 'Primary');
    const otherNote = createMeeting(db, 'Other');
    const crossNoteSource = createSpeaker(db, {
      noteId: otherNote.id,
      speakerLabel: 'SPEAKER_00',
      displayName: 'Alice',
    });
    const target = createSpeaker(db, {
      noteId: note.id,
      speakerLabel: 'SPEAKER_01',
      displayName: 'Bob',
    });

    expect(() => repo.mergeSpeakers(note.id, crossNoteSource.id, target.id, {})).toThrow(
      'Source speaker not found',
    );
    expect(repo.getSpeakers(note.id).map((speaker) => speaker.id)).toEqual([target.id]);
    expect(repo.getSpeakers(otherNote.id).map((speaker) => speaker.id)).toEqual([
      crossNoteSource.id,
    ]);
  });
});

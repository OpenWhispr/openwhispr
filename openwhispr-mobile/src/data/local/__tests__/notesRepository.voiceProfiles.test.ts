import { Buffer } from 'buffer';
import { eq } from 'drizzle-orm';
import { SpeakerProfileOwnerAlreadyExistsError } from '../notesRepository';
import { notes, speakerProfiles, speakers } from '@/db/schema';
import { InvalidEmbeddingError } from '@/lib/diarization/embeddingCodec';
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
    profileId?: number | null;
    speakerLocked?: number;
    speakerLockSource?: 'user' | 'diarization' | 'suggestion' | null;
    sortOrder?: number;
  },
): Speaker =>
  db
    .insert(speakers)
    .values({
      noteId: values.noteId,
      speakerLabel: values.speakerLabel,
      displayName: values.displayName ?? null,
      profileId: values.profileId ?? null,
      speakerLocked: values.speakerLocked ?? 0,
      speakerLockSource: values.speakerLockSource ?? null,
      sortOrder: values.sortOrder ?? 0,
    })
    .returning()
    .get();

describe('LocalNotesRepository speaker profiles', () => {
  it('creates, lists, updates, and deletes profiles while storing encoded embeddings', () => {
    const { repo, db } = createMemoryRepository();
    const profile = repo.createSpeakerProfile({
      displayName: 'Alice',
      email: 'alice@example.com',
      embedding: [0.1, -1.25, 3],
      sampleCount: 2,
      consentAt: '2026-06-19T00:00:00.000Z',
    });

    expect(profile).toEqual(
      expect.objectContaining({
        displayName: 'Alice',
        email: 'alice@example.com',
        sampleCount: 2,
        isOwner: 0,
      }),
    );
    profile.embedding.forEach((value, index) => {
      expect(value).toBeCloseTo([0.1, -1.25, 3][index], 6);
    });

    const raw = db.select().from(speakerProfiles).where(eq(speakerProfiles.id, profile.id)).get();
    expect(Buffer.isBuffer(raw?.embedding)).toBe(true);
    expect(repo.getSpeakerProfiles()).toHaveLength(1);

    repo.updateSpeakerProfile(profile.id, {
      displayName: 'Alice P.',
      embedding: [0.25, -1.5, 4],
      sampleCount: 3,
    });

    const updated = repo.getSpeakerProfileById(profile.id);
    expect(updated).toEqual(
      expect.objectContaining({
        displayName: 'Alice P.',
        sampleCount: 3,
      }),
    );
    expect(updated?.embedding[0]).toBeCloseTo(0.25, 6);

    repo.deleteSpeakerProfile(profile.id);
    expect(repo.getSpeakerProfileById(profile.id)).toBeNull();
    expect(repo.getSpeakerProfiles()).toEqual([]);
  });

  it('validates profile embedding dimensions before insert and update', () => {
    const { repo } = createMemoryRepository();
    const profile = repo.createSpeakerProfile({
      displayName: 'Alice',
      embedding: [1, 2],
      consentAt: '2026-06-19T00:00:00.000Z',
    });

    expect(() =>
      repo.createSpeakerProfile({
        displayName: 'Bob',
        embedding: [1],
        consentAt: '2026-06-19T00:00:00.000Z',
      }),
    ).toThrow(InvalidEmbeddingError);
    expect(() => repo.updateSpeakerProfile(profile.id, { embedding: [1, 2, 3] })).toThrow(
      InvalidEmbeddingError,
    );
  });

  it('prevents a second owner profile and surfaces a friendly typed error', () => {
    const { repo } = createMemoryRepository();
    repo.createSpeakerProfile({
      displayName: 'Owner',
      isOwner: 1,
      embedding: [1, 2],
      consentAt: '2026-06-19T00:00:00.000Z',
    });

    let caught: unknown;
    try {
      repo.createSpeakerProfile({
        displayName: 'Second Owner',
        isOwner: 1,
        embedding: [3, 4],
        consentAt: '2026-06-19T00:00:00.000Z',
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(SpeakerProfileOwnerAlreadyExistsError);
    expect(caught).toEqual(
      expect.objectContaining({
        code: 'SPEAKER_PROFILE_OWNER_ALREADY_EXISTS',
        message: 'An owner speaker profile already exists',
      }),
    );
    expect(repo.getSpeakerProfiles()).toHaveLength(1);
  });

  it('rejects invalid owner flag values before writing profiles', () => {
    const { repo } = createMemoryRepository();
    const profile = repo.createSpeakerProfile({
      displayName: 'Owner',
      isOwner: 1,
      embedding: [1, 2],
      consentAt: '2026-06-19T00:00:00.000Z',
    });

    expect(() =>
      repo.createSpeakerProfile({
        displayName: 'Invalid Owner',
        isOwner: 2 as unknown as 1,
        embedding: [3, 4],
        consentAt: '2026-06-19T00:00:00.000Z',
      }),
    ).toThrow('isOwner must be 0 or 1');
    expect(() => repo.updateSpeakerProfile(profile.id, { isOwner: 2 as unknown as 1 })).toThrow(
      'isOwner must be 0 or 1',
    );
  });

  it('clears unlocked speaker profile links on delete while preserving user-locked names', () => {
    const { repo, db } = createMemoryRepository();
    const note = createMeeting(db);
    const profile = repo.createSpeakerProfile({
      displayName: 'Alice Profile',
      embedding: [1, 2],
      consentAt: '2026-06-19T00:00:00.000Z',
    });
    const unlocked = createSpeaker(db, {
      noteId: note.id,
      speakerLabel: 'SPEAKER_00',
      displayName: 'Suggested Alice',
      profileId: profile.id,
    });
    const locked = createSpeaker(db, {
      noteId: note.id,
      speakerLabel: 'SPEAKER_01',
      displayName: 'Locked Alice',
      profileId: profile.id,
      speakerLocked: 1,
      speakerLockSource: 'user',
      sortOrder: 1,
    });
    const userSourceLocked = createSpeaker(db, {
      noteId: note.id,
      speakerLabel: 'SPEAKER_02',
      displayName: 'User Source Alice',
      profileId: profile.id,
      speakerLocked: 0,
      speakerLockSource: 'user',
      sortOrder: 2,
    });

    repo.deleteSpeakerProfile(profile.id);

    const unlockedAfter = db.select().from(speakers).where(eq(speakers.id, unlocked.id)).get();
    const lockedAfter = db.select().from(speakers).where(eq(speakers.id, locked.id)).get();
    const userSourceLockedAfter = db
      .select()
      .from(speakers)
      .where(eq(speakers.id, userSourceLocked.id))
      .get();
    expect(unlockedAfter).toEqual(
      expect.objectContaining({
        displayName: 'Suggested Alice',
        profileId: null,
        pendingSync: 1,
      }),
    );
    expect(lockedAfter).toEqual(
      expect.objectContaining({
        displayName: 'Locked Alice',
        profileId: profile.id,
        speakerLocked: 1,
        speakerLockSource: 'user',
      }),
    );
    expect(userSourceLockedAfter).toEqual(
      expect.objectContaining({
        displayName: 'User Source Alice',
        profileId: profile.id,
        speakerLocked: 0,
        speakerLockSource: 'user',
      }),
    );
    expect(repo.getSpeakerProfiles()).toEqual([]);
  });

  it('clears unlocked speaker links and hard-deletes all profiles', () => {
    const { repo, db } = createMemoryRepository();
    const note = createMeeting(db);
    const first = repo.createSpeakerProfile({
      displayName: 'Alice Profile',
      embedding: [1, 2],
      consentAt: '2026-06-19T00:00:00.000Z',
    });
    const second = repo.createSpeakerProfile({
      displayName: 'Bob Profile',
      embedding: [3, 4],
      consentAt: '2026-06-19T00:00:00.000Z',
    });
    const unlocked = createSpeaker(db, {
      noteId: note.id,
      speakerLabel: 'SPEAKER_00',
      profileId: first.id,
    });
    const locked = createSpeaker(db, {
      noteId: note.id,
      speakerLabel: 'SPEAKER_01',
      displayName: 'Locked Bob',
      profileId: second.id,
      speakerLocked: 1,
      speakerLockSource: 'user',
      sortOrder: 1,
    });
    const userSourceLocked = createSpeaker(db, {
      noteId: note.id,
      speakerLabel: 'SPEAKER_02',
      displayName: 'User Source Bob',
      profileId: first.id,
      speakerLocked: 0,
      speakerLockSource: 'user',
      sortOrder: 2,
    });

    repo.deleteAllSpeakerProfiles();

    expect(repo.getSpeakerProfiles()).toEqual([]);
    expect(db.select().from(speakerProfiles).all()).toEqual([]);
    expect(db.select().from(speakers).where(eq(speakers.id, unlocked.id)).get()).toEqual(
      expect.objectContaining({ profileId: null, pendingSync: 1 }),
    );
    expect(db.select().from(speakers).where(eq(speakers.id, locked.id)).get()).toEqual(
      expect.objectContaining({ displayName: 'Locked Bob', profileId: second.id }),
    );
    expect(db.select().from(speakers).where(eq(speakers.id, userSourceLocked.id)).get()).toEqual(
      expect.objectContaining({
        displayName: 'User Source Bob',
        profileId: first.id,
        speakerLocked: 0,
        speakerLockSource: 'user',
      }),
    );
  });

  it('creates the owner profile and links the speaker in one write', () => {
    const { repo, db } = createMemoryRepository();
    const note = createMeeting(db);
    const spkr = createSpeaker(db, { noteId: note.id, speakerLabel: 'SPEAKER_00' });

    const profile = repo.createOwnerProfileForSpeaker(
      spkr.id,
      {
        displayName: 'Me',
        embedding: [0.1, 0.2],
        sampleCount: 1,
        consentAt: '2026-06-19T00:00:00.000Z',
      },
      { displayName: 'Me', speakerStatus: 'locked', speakerLocked: 1, speakerLockSource: 'user' },
    );

    expect(profile).toEqual(expect.objectContaining({ displayName: 'Me', isOwner: 1 }));
    const speakerRow = db.select().from(speakers).where(eq(speakers.id, spkr.id)).get();
    expect(speakerRow).toEqual(
      expect.objectContaining({
        displayName: 'Me',
        speakerStatus: 'locked',
        speakerLocked: 1,
        speakerLockSource: 'user',
        profileId: profile.id,
        pendingSync: 1,
      }),
    );
    expect(repo.getSpeakerProfiles()).toHaveLength(1);
  });

  const claimInput = {
    displayName: 'Me',
    embedding: [0.6, 0.8],
    sampleCount: 1,
    consentAt: '2026-06-19T00:00:00.000Z',
  };

  it('refuses with the owner error, and links nothing, when an owner profile already exists', () => {
    const { repo, db } = createMemoryRepository();
    const note = createMeeting(db);
    const spkr = createSpeaker(db, { noteId: note.id, speakerLabel: 'SPEAKER_00' });
    repo.createSpeakerProfile({ ...claimInput, isOwner: 1, email: null });

    expect(() =>
      repo.createOwnerProfileForSpeaker(spkr.id, claimInput, { displayName: 'Me' }),
    ).toThrow(SpeakerProfileOwnerAlreadyExistsError);

    expect(repo.getSpeakerProfiles()).toHaveLength(1);
    const speakerRow = db.select().from(speakers).where(eq(speakers.id, spkr.id)).get();
    expect(speakerRow).toEqual(expect.objectContaining({ profileId: null, displayName: null }));
  });

  it.each([
    ['queues a shared note for sync', 0, 1],
    ['leaves a private note out of sync', 1, 0],
  ])('%s', (_label, isPrivate, expectedPendingSync) => {
    const { repo, db } = createMemoryRepository();
    const note = createMeeting(db);
    db.update(notes).set({ isPrivate, pendingSync: 0 }).where(eq(notes.id, note.id)).run();
    const spkr = createSpeaker(db, { noteId: note.id, speakerLabel: 'SPEAKER_00' });

    repo.createOwnerProfileForSpeaker(spkr.id, claimInput, { displayName: 'Me' });

    const noteRow = db.select().from(notes).where(eq(notes.id, note.id)).get();
    expect(noteRow?.pendingSync).toBe(expectedPendingSync);
  });

  it('rolls back the new owner profile when the same-transaction speaker write fails', () => {
    const { repo, db } = createMemoryRepository();
    const note = createMeeting(db);
    const spkr = createSpeaker(db, { noteId: note.id, speakerLabel: 'SPEAKER_00' });

    expect(() =>
      repo.createOwnerProfileForSpeaker(
        spkr.id,
        {
          displayName: 'Me',
          embedding: [0.1, 0.2],
          sampleCount: 1,
          consentAt: '2026-06-19T00:00:00.000Z',
        },
        // speaker_locked is NOT NULL at the DB level; forcing it to null makes the
        // second write of the transaction fail so this proves the profile insert
        // (the first write) is rolled back with it instead of left orphaned —
        // otherwise the single-owner unique index would permanently block every
        // future claim once the in-memory meeting sample is gone.
        { speakerLocked: null } as unknown as Partial<Speaker>,
      ),
    ).toThrow();

    expect(repo.getSpeakerProfiles()).toEqual([]);
    expect(db.select().from(speakerProfiles).all()).toEqual([]);
    const speakerRow = db.select().from(speakers).where(eq(speakers.id, spkr.id)).get();
    expect(speakerRow).toEqual(expect.objectContaining({ profileId: null, displayName: null }));
  });

  it.each([
    ['does not exist', () => 9999],
    [
      'was deleted',
      (db: TestDb, noteId: number) => {
        const spkr = createSpeaker(db, { noteId, speakerLabel: 'SPEAKER_00' });
        db.update(speakers)
          .set({ deletedAt: '2026-06-19T00:00:00.000Z' })
          .where(eq(speakers.id, spkr.id))
          .run();
        return spkr.id;
      },
    ],
  ])('saves no owner profile when the speaker %s', (_label, speakerIdFor) => {
    const { repo, db } = createMemoryRepository();
    const note = createMeeting(db);
    const speakerId = speakerIdFor(db, note.id);

    expect(() =>
      repo.createOwnerProfileForSpeaker(
        speakerId,
        {
          displayName: 'Me',
          embedding: [0.1, 0.2],
          sampleCount: 1,
          consentAt: '2026-06-19T00:00:00.000Z',
        },
        { displayName: 'Me' },
      ),
    ).toThrow();

    expect(db.select().from(speakerProfiles).all()).toEqual([]);
    const claimedRows = db
      .select()
      .from(speakers)
      .all()
      .filter((row) => row.profileId !== null || row.displayName !== null);
    expect(claimedRows).toEqual([]);
  });

  it('numbers speakers added by a re-diarization after the ones the note has', () => {
    const { repo, db } = createMemoryRepository();
    const note = createMeeting(db);
    createSpeaker(db, { noteId: note.id, speakerLabel: 'SPEAKER_00', sortOrder: 0 });
    createSpeaker(db, { noteId: note.id, speakerLabel: 'SPEAKER_01', sortOrder: 1 });

    repo.upsertSpeakers(note.id, [
      {
        noteId: note.id,
        speakerLabel: 'SPEAKER_02',
        speakerStatus: 'provisional',
        speakerLocked: 0,
      },
    ]);

    const added = repo.getSpeakers(note.id).find((row) => row.speakerLabel === 'SPEAKER_02');
    expect(added?.sortOrder).toBe(2);
  });

  it('hard-deletes voice profiles during account-switch data wipe', () => {
    const { repo, db } = createMemoryRepository();
    repo.createSpeakerProfile({
      displayName: 'Previous User',
      email: 'previous@example.com',
      isOwner: 1,
      embedding: [1, 2],
      consentAt: '2026-06-19T00:00:00.000Z',
    });

    repo.wipeAllSyncableData();

    expect(repo.getSpeakerProfiles()).toEqual([]);
    expect(db.select().from(speakerProfiles).all()).toEqual([]);
  });
});

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

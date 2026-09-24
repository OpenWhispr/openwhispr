import { eq } from 'drizzle-orm';
import { notes, speakers, transcriptSegments } from '@/db/schema';
import { serializeSegmentsForSync } from '@/lib/notes/remoteTranscript';
import { buildMergeTargetPatch, buildRenameSpeakerPatch } from '@/lib/diarization/speakerEdits';
import type { RemoteNote } from '@/data/types';
import { createMemoryRepository, type TestDb } from './testDb';

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

const desktopRaw = JSON.stringify([
  { text: 'Hello everyone.', source: 'mic', timestamp: 1000 },
  {
    text: 'Hi there.',
    source: 'system',
    timestamp: 1500,
    speaker: 'speaker_0',
    speakerName: 'Alice',
    speakerStatus: 'confirmed',
  },
]);

const createMeeting = (db: TestDb, over: Record<string, unknown> = {}) =>
  db
    .insert(notes)
    .values({ title: 'Meeting', content: '', noteType: 'meeting', diarizationEnabled: 1, ...over })
    .returning()
    .get();

describe('LocalNotesRepository.applyRemoteTranscript', () => {
  it('decomposes desktop transcript into segments + speakers with pendingSync=0 and stores the raw', () => {
    const { repo, db } = createMemoryRepository();
    const note = createMeeting(db);

    repo.applyRemoteTranscript(note.id, desktopRaw);

    const seg = repo.getSegments(note.id);
    const spk = repo.getSpeakers(note.id);
    expect(seg).toHaveLength(2);
    expect(spk.map((s) => s.speakerLabel)).toEqual(['__mic__', 'speaker_0']);
    expect(seg.every((s) => s.pendingSync === 0)).toBe(true);
    expect(spk.every((s) => s.pendingSync === 0)).toBe(true);

    const stored = db
      .select({ transcript: notes.transcript })
      .from(notes)
      .where(eq(notes.id, note.id))
      .get();
    expect(stored?.transcript).toBe(desktopRaw);
  });

  it('replaces existing rows on re-apply (no duplicate speakers)', () => {
    const { repo, db } = createMemoryRepository();
    const note = createMeeting(db);
    repo.applyRemoteTranscript(note.id, desktopRaw);
    repo.applyRemoteTranscript(note.id, desktopRaw);

    expect(repo.getSegments(note.id)).toHaveLength(2);
    expect(repo.getSpeakers(note.id)).toHaveLength(2);
  });

  it('leaves existing rows untouched when the raw is malformed', () => {
    const { repo, db } = createMemoryRepository();
    const note = createMeeting(db);
    repo.applyRemoteTranscript(note.id, desktopRaw);

    repo.applyRemoteTranscript(note.id, 'not-valid-json');

    // segments preserved; only the raw string is updated for idempotency
    expect(repo.getSegments(note.id)).toHaveLength(2);
    const stored = db
      .select({ transcript: notes.transcript })
      .from(notes)
      .where(eq(notes.id, note.id))
      .get();
    expect(stored?.transcript).toBe('not-valid-json');
  });

  it('preserves device-local speaker profile and color by speaker label', () => {
    const { repo, db } = createMemoryRepository();
    const note = createMeeting(db);
    db.insert(speakers)
      .values({
        noteId: note.id,
        speakerLabel: 'speaker_0',
        displayName: 'Old remote name',
        profileId: 77,
        color: '#123456',
      })
      .run();

    repo.applyRemoteTranscript(note.id, desktopRaw);

    const alice = repo.getSpeakers(note.id).find((speaker) => speaker.speakerLabel === 'speaker_0');
    expect(alice).toMatchObject({
      displayName: 'Alice',
      profileId: 77,
      color: '#123456',
    });
  });
});

describe('LocalNotesRepository.getPendingNotes transcript discovery', () => {
  it('finds public notes with dirty child rows even when the parent flag is clear', () => {
    const { repo, db } = createMemoryRepository();
    const segmentNote = createMeeting(db, { pendingSync: 0 });
    const speakerNote = createMeeting(db, { pendingSync: 0 });
    db.insert(transcriptSegments)
      .values({
        noteId: segmentNote.id,
        text: 'legacy segment',
        startMs: 0,
        endMs: 1,
        pendingSync: 1,
      })
      .run();
    db.insert(speakers)
      .values({ noteId: speakerNote.id, speakerLabel: 'speaker_0', pendingSync: 1 })
      .run();

    expect(repo.getPendingNotes().map((note) => note.id)).toEqual([segmentNote.id, speakerNote.id]);
  });

  it('does not queue a private note solely because transcript children are dirty', () => {
    const { repo, db } = createMemoryRepository();
    const note = createMeeting(db, { pendingSync: 0, isPrivate: 1 });
    db.insert(transcriptSegments)
      .values({
        noteId: note.id,
        text: 'private segment',
        startMs: 0,
        endMs: 1,
        pendingSync: 1,
      })
      .run();

    expect(repo.getPendingNotes()).toEqual([]);
  });
});

describe('LocalNotesRepository.hasDirtyTranscript', () => {
  it('is false for a pulled transcript and true after a local segment write', () => {
    const { repo, db } = createMemoryRepository();
    const note = createMeeting(db);

    repo.applyRemoteTranscript(note.id, desktopRaw);
    expect(repo.hasDirtyTranscript(note.id)).toBe(false);

    repo.replaceSegments(note.id, [
      { noteId: note.id, text: 'edited', startMs: 0, endMs: 0, sortOrder: 0 },
    ]);
    expect(repo.hasDirtyTranscript(note.id)).toBe(true);
  });

  it('is true after a local speaker rename', () => {
    const { repo, db } = createMemoryRepository();
    const note = createMeeting(db);
    repo.applyRemoteTranscript(note.id, desktopRaw);

    const alice = repo.getSpeakers(note.id).find((s) => s.speakerLabel === 'speaker_0')!;
    repo.updateSpeaker(alice.id, { displayName: 'Alice Cooper' });

    expect(repo.hasDirtyTranscript(note.id)).toBe(true);
  });
});

describe('LocalNotesRepository.markTranscriptPushed', () => {
  it('stores the raw and clears pendingSync only for the given row ids', () => {
    const { repo, db } = createMemoryRepository();
    const note = createMeeting(db);
    repo.replaceSegments(note.id, [
      { noteId: note.id, text: 'a', startMs: 0, endMs: 0, sortOrder: 0 },
      { noteId: note.id, text: 'b', startMs: 0, endMs: 0, sortOrder: 1 },
    ]);
    const seg = repo.getSegments(note.id);
    const raw = serializeSegmentsForSync(seg, repo.getSpeakers(note.id));

    // Only clear the first segment; simulate the second landing after serialization.
    repo.markTranscriptPushed(note.id, raw, [seg[0].id], []);

    const after = db
      .select()
      .from(transcriptSegments)
      .where(eq(transcriptSegments.noteId, note.id))
      .all();
    expect(after.find((s) => s.id === seg[0].id)?.pendingSync).toBe(0);
    expect(after.find((s) => s.id === seg[1].id)?.pendingSync).toBe(1);
    const stored = db
      .select({ transcript: notes.transcript })
      .from(notes)
      .where(eq(notes.id, note.id))
      .get();
    expect(stored?.transcript).toBe(raw);
  });

  it('keeps the transcript and parent dirty when the same speaker changes during the request', () => {
    const { repo, db } = createMemoryRepository();
    repo.applyRemoteNote(remoteNote({ transcript: desktopRaw }), noFolder);
    const [note] = repo.getAllNotes();
    const alice = repo
      .getSpeakers(note.id)
      .find((speaker) => speaker.speakerLabel === 'speaker_0')!;
    const segmentIds = repo.getSegments(note.id).map((segment) => segment.id);
    const speakerIds = repo.getSpeakers(note.id).map((speaker) => speaker.id);
    const pushedRaw = serializeSegmentsForSync(
      repo.getSegments(note.id),
      repo.getSpeakers(note.id),
    );

    // Simulate an edit landing after serialization but before the HTTP response.
    repo.updateSpeaker(alice.id, { displayName: 'Alice Cooper' });
    repo.markNotePushed(repo.getNoteById(note.id)!, 'srv-1', '2026-07-09T11:00:00.000Z');
    repo.markTranscriptPushed(note.id, pushedRaw, segmentIds, speakerIds);

    const afterSpeaker = repo.getSpeakers(note.id).find((speaker) => speaker.id === alice.id);
    const afterNote = db.select().from(notes).where(eq(notes.id, note.id)).get();
    expect(afterSpeaker).toMatchObject({ displayName: 'Alice Cooper', pendingSync: 1 });
    expect(afterNote?.pendingSync).toBe(1);
    expect(repo.getPendingNotes().map((pending) => pending.id)).toContain(note.id);
  });
});

describe('parent-note dirty marking on transcript edits', () => {
  it('marks a shared meeting note pendingSync after replaceSegments', () => {
    const { repo, db } = createMemoryRepository();
    const note = createMeeting(db, { pendingSync: 0 });
    repo.replaceSegments(note.id, [
      { noteId: note.id, text: 'x', startMs: 0, endMs: 0, sortOrder: 0 },
    ]);

    const row = db
      .select({ pendingSync: notes.pendingSync })
      .from(notes)
      .where(eq(notes.id, note.id))
      .get();
    expect(row?.pendingSync).toBe(1);
  });

  it('marks pendingSync after updateSpeaker and mergeSpeakers', () => {
    const { repo, db } = createMemoryRepository();
    const note = createMeeting(db, { pendingSync: 0 });
    db.insert(speakers).values({ noteId: note.id, speakerLabel: 'speaker_0', sortOrder: 0 }).run();
    db.insert(speakers).values({ noteId: note.id, speakerLabel: 'speaker_1', sortOrder: 1 }).run();
    const [s0, s1] = repo.getSpeakers(note.id);

    repo.updateSpeaker(s0.id, { displayName: 'Renamed' });
    expect(
      db.select({ p: notes.pendingSync }).from(notes).where(eq(notes.id, note.id)).get()?.p,
    ).toBe(1);

    db.update(notes).set({ pendingSync: 0 }).where(eq(notes.id, note.id)).run();
    repo.mergeSpeakers(note.id, s1.id, s0.id, {});
    expect(
      db.select({ p: notes.pendingSync }).from(notes).where(eq(notes.id, note.id)).get()?.p,
    ).toBe(1);
  });

  it('does NOT mark a private note pendingSync (never syncs)', () => {
    const { repo, db } = createMemoryRepository();
    const note = createMeeting(db, { pendingSync: 0, isPrivate: 1 });
    repo.replaceSegments(note.id, [
      { noteId: note.id, text: 'x', startMs: 0, endMs: 0, sortOrder: 0 },
    ]);

    const row = db
      .select({ pendingSync: notes.pendingSync })
      .from(notes)
      .where(eq(notes.id, note.id))
      .get();
    expect(row?.pendingSync).toBe(0);
  });
});

describe('applyRemoteNote transcript integration', () => {
  it('builds segments + speakers when inserting a new remote meeting note', () => {
    const { repo } = createMemoryRepository();
    repo.applyRemoteNote(remoteNote({ transcript: desktopRaw }), noFolder);

    const [note] = repo.getAllNotes();
    expect(repo.getSegments(note.id)).toHaveLength(2);
    expect(repo.getSpeakers(note.id).map((s) => s.speakerLabel)).toEqual(['__mic__', 'speaker_0']);
  });

  it('rebuilds segments when an existing note receives a changed transcript', () => {
    const { repo } = createMemoryRepository();
    repo.applyRemoteNote(remoteNote({ transcript: desktopRaw }), noFolder);
    const [note] = repo.getAllNotes();

    const changed = JSON.stringify([{ text: 'Only one line now.', source: 'mic', timestamp: 5 }]);
    repo.applyRemoteNote(
      remoteNote({ transcript: changed, updated_at: '2026-07-09T11:00:00.000Z' }),
      noFolder,
    );

    const seg = repo.getSegments(note.id);
    expect(seg).toHaveLength(1);
    expect(seg[0].text).toBe('Only one line now.');
  });

  it('does not rebuild when the transcript is unchanged (segment ids stable)', () => {
    const { repo } = createMemoryRepository();
    repo.applyRemoteNote(remoteNote({ transcript: desktopRaw }), noFolder);
    const [note] = repo.getAllNotes();
    const idsBefore = repo.getSegments(note.id).map((s) => s.id);

    repo.applyRemoteNote(
      remoteNote({ transcript: desktopRaw, updated_at: '2026-07-09T11:00:00.000Z' }),
      noFolder,
    );

    expect(repo.getSegments(note.id).map((s) => s.id)).toEqual(idsBefore);
  });

  it('preserves local segments when the remote transcript is null', () => {
    const { repo } = createMemoryRepository();
    repo.applyRemoteNote(remoteNote({ transcript: desktopRaw }), noFolder);
    const [note] = repo.getAllNotes();

    repo.applyRemoteNote(
      remoteNote({ transcript: null, updated_at: '2026-07-09T11:00:00.000Z' }),
      noFolder,
    );

    expect(repo.getSegments(note.id)).toHaveLength(2);
  });

  it('does not clobber locally-dirty transcript rows on remote change', () => {
    const { repo } = createMemoryRepository();
    repo.applyRemoteNote(remoteNote({ transcript: desktopRaw }), noFolder);
    const [note] = repo.getAllNotes();

    // Local edit makes the note transcript-dirty (also marks the note pendingSync).
    repo.replaceSegments(note.id, [
      { noteId: note.id, text: 'local edit', startMs: 0, endMs: 0, sortOrder: 0 },
    ]);
    // Clear the note-level flag so applyRemoteNote does not short-circuit on it,
    // isolating the transcript-dirty guard.
    repo.markNotePushed(repo.getNoteById(note.id)!, 'srv-1', '2026-07-09T10:30:00.000Z');

    const changed = JSON.stringify([{ text: 'remote wins?', source: 'mic', timestamp: 5 }]);
    repo.applyRemoteNote(
      remoteNote({ transcript: changed, updated_at: '2026-07-09T12:00:00.000Z' }),
      noFolder,
    );

    const seg = repo.getSegments(note.id);
    expect(seg).toHaveLength(1);
    expect(seg[0].text).toBe('local edit');
  });
});

describe('desktop speaker edits across transcript roundtrips', () => {
  function pushAndPull(
    repo: ReturnType<typeof createMemoryRepository>['repo'],
    noteId: number,
  ): ReturnType<typeof createMemoryRepository> & { raw: string; noteId: number } {
    const segments = repo.getSegments(noteId);
    const speakerRows = repo.getSpeakers(noteId);
    const raw = serializeSegmentsForSync(
      segments,
      speakerRows,
      repo.getNoteById(noteId)?.transcript,
    );
    repo.markTranscriptPushed(
      noteId,
      raw,
      segments.map((segment) => segment.id),
      speakerRows.map((speaker) => speaker.id),
    );
    expect(repo.hasDirtyTranscript(noteId)).toBe(false);
    expect(repo.getNoteById(noteId)?.transcript).toBe(raw);

    const fresh = createMemoryRepository();
    fresh.repo.applyRemoteNote(remoteNote({ transcript: raw }), noFolder);
    const [note] = fresh.repo.getAllNotes();
    return { ...fresh, raw, noteId: note.id };
  }

  it('keeps the destination name when the merged source spoke first', () => {
    const { repo, db } = createMemoryRepository();
    const note = createMeeting(db);
    const original = [
      {
        text: 'Hello',
        source: 'system',
        timestamp: 1000,
        speaker: 'speaker_0',
        speakerName: 'Alice',
      },
      { text: 'Hi', source: 'system', timestamp: 1500, speaker: 'speaker_1', speakerName: 'Bob' },
    ];
    repo.applyRemoteTranscript(note.id, JSON.stringify(original));
    const [alice, bob] = repo.getSpeakers(note.id);
    repo.mergeSpeakers(note.id, alice.id, bob.id, buildMergeTargetPatch(bob));

    const pulled = pushAndPull(repo, note.id);
    expect(pulled.repo.getSpeakers(pulled.noteId)).toEqual([
      expect.objectContaining({ speakerLabel: 'speaker_1', displayName: 'Bob', speakerLocked: 1 }),
    ]);
    expect(JSON.parse(pulled.raw)).toEqual(
      original.map((item) => ({
        ...item,
        speaker: 'speaker_1',
        speakerName: 'Bob',
        speakerStatus: 'locked',
        speakerLocked: true,
        speakerLockSource: 'user',
      })),
    );
  });

  it.each([null, 'Bob'])('clears obsolete suggestions when merging into %s', (displayName) => {
    const { repo, db } = createMemoryRepository();
    const note = createMeeting(db);
    repo.applyRemoteTranscript(
      note.id,
      JSON.stringify([
        {
          text: 'Suggested speaker',
          source: 'system',
          timestamp: 1000,
          speaker: 'speaker_0',
          suggestedName: 'Alice',
          suggestedProfileId: 23,
          speakerStatus: 'suggested',
          futureMetadata: { confidence: 0.91 },
        },
        { text: 'Destination', source: 'system', speaker: 'speaker_1', speakerName: displayName },
      ]),
    );
    const [source, target] = repo.getSpeakers(note.id);
    repo.mergeSpeakers(note.id, source.id, target.id, buildMergeTargetPatch(target));

    const pulled = pushAndPull(repo, note.id);
    const [merged] = JSON.parse(pulled.raw);
    expect(merged).not.toHaveProperty('suggestedName');
    expect(merged).not.toHaveProperty('suggestedProfileId');
    expect(merged).toMatchObject({
      speaker: 'speaker_1',
      speakerLocked: true,
      timestamp: 1000,
      futureMetadata: { confidence: 0.91 },
    });
    expect(pulled.repo.getSpeakers(pulled.noteId)[0].displayName).toBe(displayName);
  });

  it('keeps attribution when a system speaker is merged into You', () => {
    const { repo, db } = createMemoryRepository();
    const note = createMeeting(db);
    repo.applyRemoteTranscript(note.id, desktopRaw);
    const [mic, alice] = repo.getSpeakers(note.id);
    repo.mergeSpeakers(note.id, alice.id, mic.id, buildMergeTargetPatch(mic));

    const pulled = pushAndPull(repo, note.id);
    expect(pulled.repo.getSegments(pulled.noteId).map((segment) => segment.speakerLabel)).toEqual([
      '__mic__',
      '__mic__',
    ]);
    expect(pulled.repo.getSpeakers(pulled.noteId)).toEqual([
      expect.objectContaining({ speakerLabel: '__mic__', displayName: 'You' }),
    ]);
    expect(JSON.parse(pulled.raw)[1]).toMatchObject({ source: 'mic', timestamp: 1500 });
    expect(JSON.parse(pulled.raw)[1]).not.toHaveProperty('speaker');
  });

  it('uses system attribution when You is merged into a named speaker', () => {
    const { repo, db } = createMemoryRepository();
    const note = createMeeting(db);
    repo.applyRemoteTranscript(note.id, desktopRaw);
    const [mic, alice] = repo.getSpeakers(note.id);
    repo.mergeSpeakers(note.id, mic.id, alice.id, buildMergeTargetPatch(alice));

    const pulled = pushAndPull(repo, note.id);
    expect(pulled.repo.getSpeakers(pulled.noteId)).toEqual([
      expect.objectContaining({ speakerLabel: 'speaker_0', displayName: 'Alice' }),
    ]);
    expect(JSON.parse(pulled.raw)[0]).toMatchObject({
      source: 'system',
      speaker: 'speaker_0',
      speakerName: 'Alice',
      timestamp: 1000,
    });
  });

  it('locks every renamed line even when the first line was already locked', () => {
    const { repo, db } = createMemoryRepository();
    const note = createMeeting(db);
    const original = [
      {
        text: 'First',
        source: 'system',
        timestamp: 1000,
        speaker: 'speaker_0',
        speakerName: 'Alice',
        speakerStatus: 'locked',
        speakerLocked: true,
        speakerLockSource: 'user',
      },
      {
        text: 'Second',
        source: 'system',
        timestamp: 1500,
        speaker: 'speaker_0',
        speakerName: 'Alice',
        speakerStatus: 'provisional',
        speakerLocked: false,
        futureMetadata: { confidence: 0.91 },
      },
    ];
    repo.applyRemoteTranscript(note.id, JSON.stringify(original));
    const [alice] = repo.getSpeakers(note.id);
    repo.updateSpeaker(alice.id, buildRenameSpeakerPatch(alice, 'Alicia'));

    const pulled = pushAndPull(repo, note.id);
    expect(JSON.parse(pulled.raw)).toEqual(
      original.map((item) => ({
        ...item,
        speakerName: 'Alicia',
        speakerStatus: 'locked',
        speakerLocked: true,
        speakerLockSource: 'user',
      })),
    );
    expect(pulled.repo.getSpeakers(pulled.noteId)[0]).toMatchObject({
      displayName: 'Alicia',
      speakerLocked: 1,
    });
  });
});

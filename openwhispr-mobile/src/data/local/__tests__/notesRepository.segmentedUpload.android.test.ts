jest.mock('expo-file-system/legacy', () => ({
  documentDirectory: 'file:///app/documents/',
  deleteAsync: jest.fn().mockResolvedValue(undefined),
}));
import type { RemoteNote } from '@/data/types';
// Load the adapter before mocking the extensionless path: Jest keys mocks by
// physical file, while Metro resolves this import separately for each platform.
const androidTranscript = jest.requireActual<typeof import('@/lib/notes/remoteTranscript.android')>(
  '@/lib/notes/remoteTranscript.android',
);
jest.doMock('@/lib/notes/remoteTranscript', () => androidTranscript);
const { serializeSegmentsForSync } = androidTranscript;
const { LocalNotesRepository } =
  require('../notesRepository') as typeof import('../notesRepository');
const { createMemoryRepository } = require('./testDb') as typeof import('./testDb');

// Same synthetic transcript as the prepared installed segmented-upload fixture.
const transcript = JSON.stringify([
  {
    text: 'Synthetic segment one: the blue folder stays on the shelf.',
    source: 'mic',
    timestamp: 0,
  },
  {
    text: 'Synthetic segment two: no delivery has been approved.',
    source: 'system',
    timestamp: 1500,
    speaker: 'speaker_0',
    speakerName: 'Test Speaker',
    speakerStatus: 'confirmed',
  },
]);
const remote: RemoteNote = {
  id: 'segmented-upload-fixture',
  client_note_id: '5431705f-de43-4e3e-b9de-acfe9aedf0cd',
  title: 'Disposable segmented upload acceptance',
  content: 'Original personal note for the segmented upload test.',
  enhanced_content: null,
  enhancement_prompt: null,
  note_type: 'upload',
  source_file: null,
  audio_duration_seconds: 3,
  folder_id: null,
  participants: null,
  calendar_event_id: null,
  transcript,
  deleted_at: null,
  updated_at: '2026-11-02T09:00:00.000Z',
};

it.each(['[[]]', '[{}]', '[{"text":7}]', '[{"text":"valid line"},[]]'])(
  'preserves saved upload speech and personal notes when a corrupt transcript arrives: %s',
  (raw) => {
    const { repo } = createMemoryRepository();
    repo.applyRemoteNote(remote, () => null);
    const [note] = repo.getAllNotes();
    const segments = repo.getSegments(note.id);
    const speakers = repo.getSpeakers(note.id);
    expect(segments.map((segment) => segment.text)).toEqual([
      'Synthetic segment one: the blue folder stays on the shelf.',
      'Synthetic segment two: no delivery has been approved.',
    ]);
    repo.applyRemoteNote(
      { ...remote, transcript: raw, updated_at: '2026-11-02T10:00:00.000Z' },
      () => null,
    );
    expect(repo.getSegments(note.id)).toEqual(segments);
    expect(repo.getSpeakers(note.id)).toEqual(speakers);
    expect(repo.getNoteById(note.id)?.content).toBe(remote.content);
  },
);

it('persists My notes separately from the exact synced transcript and later enhanced text', () => {
  const { repo, db } = createMemoryRepository();
  repo.applyRemoteNote(remote, () => null);
  const [note] = repo.getAllNotes();
  const segments = repo.getSegments(note.id);
  const speakers = repo.getSpeakers(note.id);
  const content = 'Edited personal note: keep both transcript segments unchanged.';
  repo.updateNote(note.id, { content });
  // A separate repository instance reads SQLite, not the original object or UI cache.
  const reread = new LocalNotesRepository(
    db as unknown as ConstructorParameters<typeof LocalNotesRepository>[0],
  );
  const saved = reread.getNoteById(note.id)!;
  expect(saved.content).toBe(content);
  expect(saved.transcript).toBe(transcript);
  expect(saved.pendingSync).toBe(1);
  expect(reread.getSegments(note.id)).toEqual(segments);
  expect(reread.getSpeakers(note.id)).toEqual(speakers);
  expect(
    serializeSegmentsForSync(
      reread.getSegments(note.id),
      reread.getSpeakers(note.id),
      saved.transcript,
    ),
  ).toBe(transcript);

  reread.markNotePushed(saved, remote.id, '2026-11-02T10:00:00.000Z');
  reread.applyRemoteNote(
    {
      ...remote,
      content,
      enhanced_content: 'Synthetic enhanced fixture, not model output.',
      updated_at: '2026-11-02T11:00:00.000Z',
    },
    () => null,
  );
  expect(reread.getNoteById(note.id)).toMatchObject({
    content,
    enhancedContent: 'Synthetic enhanced fixture, not model output.',
    transcript,
    pendingSync: 0,
  });
  expect(reread.getSegments(note.id)).toEqual(segments);
  expect(reread.getSpeakers(note.id)).toEqual(speakers);
});

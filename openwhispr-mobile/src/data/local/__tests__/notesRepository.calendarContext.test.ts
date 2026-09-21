import { createMemoryRepository } from './testDb';
import type { RemoteNote } from '@/data/types';

const remoteNote = (overrides: Partial<RemoteNote> = {}): RemoteNote => ({
  id: 'remote-note-1',
  client_note_id: 'client-note-1',
  title: 'Planning Sync',
  content: 'Discuss launch.',
  enhanced_content: null,
  enhancement_prompt: null,
  note_type: 'meeting',
  source_file: null,
  audio_duration_seconds: null,
  folder_id: null,
  participants: '[{"email":"alice@example.com"}]',
  calendar_event_id: '{"eventId":"event-1"}',
  transcript: null,
  deleted_at: null,
  updated_at: '2026-06-26T10:00:00.000Z',
  ...overrides,
});

describe('LocalNotesRepository calendar context sync', () => {
  it('applies pulled calendar context to new notes', () => {
    const { repo } = createMemoryRepository();

    repo.applyRemoteNote(remoteNote(), () => null);

    const [note] = repo.getAllNotes();
    expect(note).toMatchObject({
      remoteId: 'remote-note-1',
      clientNoteId: 'client-note-1',
      calendarEventId: '{"eventId":"event-1"}',
      participants: '[{"email":"alice@example.com"}]',
      pendingSync: 0,
    });
  });

  it('applies pulled calendar context to existing clean notes', () => {
    const { repo } = createMemoryRepository();
    const local = repo.createNote('Planning Sync', '');
    repo.setNoteClientId(local.id, 'client-note-1');
    repo.markNotePushed(repo.getNoteById(local.id)!, 'remote-note-1', '2026-06-26T09:00:00.000Z');

    repo.applyRemoteNote(
      remoteNote({
        participants: '[]',
        calendar_event_id: '{"eventId":"event-2"}',
        updated_at: '2026-06-26T11:00:00.000Z',
      }),
      () => null,
    );

    expect(repo.getNoteById(local.id)).toMatchObject({
      calendarEventId: '{"eventId":"event-2"}',
      participants: '[]',
      pendingSync: 0,
      updatedAt: '2026-06-26T11:00:00.000Z',
    });
  });

  it('marks public calendar context changes pending without syncing local-only diarization fields', () => {
    const { repo } = createMemoryRepository();
    const local = repo.createNote('Planning Sync', '');
    repo.markNotePushed(repo.getNoteById(local.id)!, 'remote-note-1', '2026-06-26T09:00:00.000Z');

    repo.updateNoteMeta(local.id, {
      sourceFile: 'file://meeting.wav',
      expectedSpeakerCount: 3,
    });
    expect(repo.getNoteById(local.id)).toMatchObject({
      sourceFile: 'file://meeting.wav',
      expectedSpeakerCount: 3,
      pendingSync: 0,
    });

    repo.updateNoteCalendarContext(local.id, {
      calendarEventId: '{"eventId":"event-1"}',
      participants: '[{"email":"alice@example.com"}]',
    });
    expect(repo.getNoteById(local.id)).toMatchObject({
      calendarEventId: '{"eventId":"event-1"}',
      participants: '[{"email":"alice@example.com"}]',
      pendingSync: 1,
    });
  });

  it('keeps private calendar context local-only', () => {
    const { repo } = createMemoryRepository();
    const local = repo.createNote('Planning Sync', '');
    repo.markNotePushed(repo.getNoteById(local.id)!, 'remote-note-1', '2026-06-26T09:00:00.000Z');
    repo.setNotePrivacy(local.id, true);

    repo.updateNoteCalendarContext(local.id, {
      calendarEventId: '{"eventId":"private-event"}',
      participants: '[{"email":"private@example.com"}]',
    });

    expect(repo.getNoteById(local.id)).toMatchObject({
      isPrivate: 1,
      calendarEventId: '{"eventId":"private-event"}',
      participants: '[{"email":"private@example.com"}]',
      pendingSync: 0,
    });
  });
});

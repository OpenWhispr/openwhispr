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
  participants: null,
  calendar_event_id: null,
  transcript: null,
  deleted_at: null,
  created_at: '2026-06-01T09:00:00.000Z',
  updated_at: '2026-06-26T10:00:00.000Z',
  ...overrides,
});

describe('LocalNotesRepository pulled created_at', () => {
  it('keeps the server creation time on a pulled note', () => {
    const { repo } = createMemoryRepository();

    repo.applyRemoteNote(remoteNote(), () => null);

    expect(repo.getAllNotes()[0].createdAt).toBe('2026-06-01T09:00:00.000Z');
  });

  it('repairs the creation time of a note pulled before it was synced', () => {
    const { repo } = createMemoryRepository();
    repo.applyRemoteNote(remoteNote({ created_at: undefined }), () => null);
    const [pulled] = repo.getAllNotes();
    expect(pulled.createdAt).not.toBe('2026-06-01T09:00:00.000Z');

    repo.applyRemoteNote(remoteNote({ updated_at: '2026-06-27T10:00:00.000Z' }), () => null);

    expect(repo.getNoteById(pulled.id)?.createdAt).toBe('2026-06-01T09:00:00.000Z');
  });

  it('repairs the creation time from the server’s reply to a push', () => {
    const { repo } = createMemoryRepository();
    repo.applyRemoteNote(remoteNote({ created_at: undefined }), () => null);
    const [pulled] = repo.getAllNotes();
    repo.updateNote(pulled.id, { title: 'Planning Sync, edited' });

    repo.markNotePushed(
      repo.getNoteById(pulled.id)!,
      'remote-note-1',
      '2026-09-28T10:00:00.000Z',
      undefined,
      '2026-06-01T09:00:00.000Z',
    );

    const pushed = repo.getNoteById(pulled.id)!;
    expect(pushed.createdAt).toBe('2026-06-01T09:00:00.000Z');
    expect(pushed.cloudUpdatedAt).toBe('2026-09-28T10:00:00.000Z');
    expect(pushed.pendingSync).toBe(0);
  });

  it('leaves the stored creation time alone when the server sends none', () => {
    const { repo } = createMemoryRepository();
    const local = repo.createNote('Planning Sync', '');
    repo.setNoteClientId(local.id, 'client-note-1');
    repo.markNotePushed(repo.getNoteById(local.id)!, 'remote-note-1', '2026-06-26T09:00:00.000Z');
    const { createdAt } = repo.getNoteById(local.id)!;

    repo.applyRemoteNote(remoteNote({ created_at: undefined }), () => null);

    expect(repo.getNoteById(local.id)?.createdAt).toBe(createdAt);
  });
});

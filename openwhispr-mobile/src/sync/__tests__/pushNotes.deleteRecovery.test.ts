jest.mock('expo-file-system/legacy', () => ({
  documentDirectory: 'file:///app/documents/',
  deleteAsync: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('@sentry/react-native', () => ({
  captureMessage: jest.fn(),
  captureException: jest.fn(),
  addBreadcrumb: jest.fn(),
}));
jest.mock('@/data', () => ({
  get notesRepository() {
    return mockRepository;
  },
  spacesRepository: { listSpaces: jest.fn(() => []) },
}));
jest.mock('@/data/remote/notesApi', () => ({
  batchCreateNotes: jest.fn(),
  updateNote: jest.fn(),
  deleteNote: jest.fn(),
}));

import * as FileSystem from 'expo-file-system/legacy';
import { eq } from 'drizzle-orm';
import { notes, speakers, spaces, transcriptSegments } from '@/db/schema';
import type { RemoteNote } from '@/data/types';
import { createMemoryRepository } from '@/data/local/__tests__/testDb';
import type { LocalNotesRepository } from '@/data/local/notesRepository';
import { deleteNote as deleteRemoteNote } from '@/data/remote/notesApi';
import { pushNotes } from '../pushNotes';
import {
  TEAM_NOTES_CURSOR_KEY,
  TEAM_NOTES_CURSOR_ID_KEY,
  TEAM_FOLDERS_CURSOR_KEY,
} from '../teamCursors';

let mockRepository: LocalNotesRepository;
const mockDeleteRemoteNote = jest.mocked(deleteRemoteNote);
const transcript = JSON.stringify([
  {
    text: 'The launch is on Tuesday.',
    source: 'system',
    timestamp: 1000,
    speaker: 'speaker_0',
    speakerName: 'Alice',
  },
]);
const serverNote: RemoteNote = {
  id: 'remote-meeting',
  client_note_id: 'client-meeting',
  title: 'Team planning',
  content: '',
  note_type: 'meeting',
  source_file: null,
  audio_duration_seconds: null,
  enhanced_content: null,
  enhancement_prompt: null,
  folder_id: null,
  participants: null,
  calendar_event_id: null,
  transcript,
  deleted_at: null,
  updated_at: '2026-10-20T10:00:00.000Z',
  space_id: 'remote-team',
  user_id: 'teammate',
};

function seedTeamMeeting() {
  const { repo, db } = createMemoryRepository();
  mockRepository = repo;
  const team = db
    .insert(spaces)
    .values({
      clientSpaceId: 'client-team',
      cloudSpaceId: 'remote-team',
      kind: 'team',
      name: 'Team',
      myRole: 'member',
    })
    .returning()
    .get();
  repo.applyRemoteNote(serverNote, () => null, { spaceId: team.id, applyOwnership: true });
  const note = repo.getAllNotes()[0];
  expect(repo.getSegments(note.id)).toHaveLength(1);
  expect(repo.getSpeakers(note.id)).toHaveLength(1);
  return { repo, note, team, db };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockDeleteRemoteNote.mockResolvedValue(undefined);
});

it('keeps a synced meeting transcript until the queued delete is accepted', () => {
  const { repo, note } = seedTeamMeeting();
  repo.deleteNote(note.id);

  expect(repo.getAllNotes()).toHaveLength(0);
  expect(repo.getPendingNotes()).toHaveLength(1);
  expect(repo.getSegments(note.id)).toHaveLength(1);
  expect(repo.getSpeakers(note.id)).toHaveLength(1);
});

it('restores a permission-denied team delete without losing the unchanged server transcript', async () => {
  const { repo, note, team } = seedTeamMeeting();
  const cursorKeys = [TEAM_NOTES_CURSOR_KEY, TEAM_NOTES_CURSOR_ID_KEY, TEAM_FOLDERS_CURSOR_KEY];
  for (const key of cursorKeys) repo.setSyncState(key, 'previous-cursor');
  repo.deleteNote(note.id);
  mockDeleteRemoteNote.mockRejectedValue(
    Object.assign(new Error('Only the owner can delete this note'), {
      status: 403,
      code: 'note_access_denied',
    }),
  );

  await expect(pushNotes()).resolves.toBeUndefined();
  expect(repo.getAllNotes().map((row) => row.id)).toContain(note.id);
  expect(repo.getPendingNotes()).toHaveLength(0);
  for (const key of cursorKeys) expect(repo.getSyncState(key)).toBeNull();

  repo.applyRemoteNote(serverNote, () => null, { spaceId: team.id, applyOwnership: true });
  expect(repo.getSegments(note.id).map((segment) => segment.text)).toEqual([
    'The launch is on Tuesday.',
  ]);
  expect(repo.getSpeakers(note.id)[0].displayName).toBe('Alice');
  await pushNotes();
  expect(mockDeleteRemoteNote).toHaveBeenCalledTimes(1);
});

it('cleans up the transcript and managed recording after a server-accepted delete', async () => {
  const { repo, note } = seedTeamMeeting();
  const uri = `${FileSystem.documentDirectory}meeting-${note.id}.wav`;
  repo.updateNoteMeta(note.id, { sourceFile: uri });
  repo.deleteNote(note.id);

  await pushNotes();

  expect(mockDeleteRemoteNote).toHaveBeenCalledWith(serverNote.id);
  expect(repo.getNoteById(note.id)).toBeNull();
  expect(repo.getSegments(note.id)).toHaveLength(0);
  expect(repo.getSpeakers(note.id)).toHaveLength(0);
  expect(FileSystem.deleteAsync).toHaveBeenCalledWith(uri, { idempotent: true });
});

it('keeps an offline delete queued with its transcript and recording intact', async () => {
  const { repo, note } = seedTeamMeeting();
  const uri = `${FileSystem.documentDirectory}meeting-${note.id}.wav`;
  repo.updateNoteMeta(note.id, { sourceFile: uri });
  repo.deleteNote(note.id);
  mockDeleteRemoteNote.mockRejectedValue(Object.assign(new Error('Unavailable'), { status: 503 }));

  await expect(pushNotes()).rejects.toThrow('1 operation(s) failed');

  expect(repo.getAllNotes()).toHaveLength(0);
  expect(repo.getPendingNotes()).toHaveLength(1);
  expect(repo.getSegments(note.id)).toHaveLength(1);
  expect(repo.getSpeakers(note.id)).toHaveLength(1);
  expect(FileSystem.deleteAsync).not.toHaveBeenCalled();
});

it('still cleans up a meeting that has never been uploaded immediately', () => {
  const { repo } = createMemoryRepository();
  mockRepository = repo;
  const note = repo.createNote('Local meeting', '');
  const uri = `${FileSystem.documentDirectory}meeting-${note.id}.wav`;
  repo.updateNoteMeta(note.id, { sourceFile: uri });
  repo.applyRemoteTranscript(note.id, transcript);

  repo.deleteNote(note.id);

  expect(repo.getSegments(note.id)).toHaveLength(0);
  expect(repo.getSpeakers(note.id)).toHaveLength(0);
  expect(FileSystem.deleteAsync).toHaveBeenCalledWith(uri, { idempotent: true });
});

it('repulls unchanged server raw after a denied delete of locally edited transcript rows', async () => {
  const { repo, note, team, db } = seedTeamMeeting();
  db.update(transcriptSegments)
    .set({ text: 'Local edit', pendingSync: 1 })
    .where(eq(transcriptSegments.noteId, note.id))
    .run();
  db.update(speakers)
    .set({ displayName: 'Local name', pendingSync: 1 })
    .where(eq(speakers.noteId, note.id))
    .run();
  repo.deleteNote(note.id);
  mockDeleteRemoteNote.mockRejectedValue(
    Object.assign(new Error('Denied'), { status: 403, code: 'note_access_denied' }),
  );
  await expect(pushNotes()).resolves.toBeUndefined();
  expect(repo.getPendingNotes()).toHaveLength(0);
  expect(repo.isNotePushRejected(note.id)).toBe(true);
  repo.applyRemoteNote(serverNote, () => null, { spaceId: team.id, applyOwnership: true });
  expect(repo.getSegments(note.id)[0].text).toBe('The launch is on Tuesday.');
  expect(repo.getSpeakers(note.id)[0].displayName).toBe('Alice');
  expect(repo.isNotePushRejected(note.id)).toBe(false);
});

it('does not restore a note newly owned by a folder deletion during DELETE', async () => {
  const { repo, note } = seedTeamMeeting();
  const folder = repo.createFolder('Team folder', note.spaceId ?? undefined);
  repo.moveNoteToFolder(note.id, folder.id);
  repo.deleteNote(note.id);
  mockDeleteRemoteNote.mockImplementation(async () => {
    repo.deleteFolderCascade(folder.id);
    throw Object.assign(new Error('Denied'), { status: 403, code: 'note_access_denied' });
  });
  await expect(pushNotes()).resolves.toBeUndefined();
  expect(repo.getNoteById(note.id)?.deletedAt).not.toBeNull();
  expect(repo.getAllNotes()).toHaveLength(0);
  expect(repo.getSegments(note.id)).toHaveLength(1);
});

it('does not clear a newer note operation when DELETE is denied', async () => {
  const { repo, note, db } = seedTeamMeeting();
  repo.deleteNote(note.id);
  mockDeleteRemoteNote.mockImplementation(async () => {
    db.update(notes)
      .set({ title: 'Newer operation', updatedAt: '2026-10-21' })
      .where(eq(notes.id, note.id))
      .run();
    throw Object.assign(new Error('Denied'), { status: 403, code: 'note_access_denied' });
  });
  await expect(pushNotes()).resolves.toBeUndefined();
  expect(repo.getPendingNotes()).toHaveLength(1);
  expect(repo.getNoteById(note.id)?.deletedAt).not.toBeNull();
});

it.each([
  [404, undefined],
  [403, 'space_access_revoked'],
])('finishes a deleted note whose server target is gone (%s, %s)', async (status, code) => {
  const { repo, note } = seedTeamMeeting();
  repo.deleteNote(note.id);
  mockDeleteRemoteNote.mockRejectedValue(Object.assign(new Error('Gone'), { status, code }));
  await expect(pushNotes()).resolves.toBeUndefined();
  expect(repo.getNoteById(note.id)).toBeNull();
  expect(repo.getSegments(note.id)).toHaveLength(0);
});

it.each([
  { isPrivate: 1 },
  { remoteId: 'replacement-server-note' },
  { clientNoteId: 'replacement-client-note' },
])('preserves a newer identity or privacy transition during DELETE: %j', async (change) => {
  const { repo, note, db } = seedTeamMeeting();
  repo.deleteNote(note.id);
  mockDeleteRemoteNote.mockImplementation(async () => {
    db.update(notes).set(change).where(eq(notes.id, note.id)).run();
    throw Object.assign(new Error('Denied'), { status: 403, code: 'note_access_denied' });
  });
  await expect(pushNotes()).resolves.toBeUndefined();
  expect(repo.getNoteById(note.id)).toMatchObject({ ...change, pendingSync: 1 });
  expect(repo.getNoteById(note.id)?.deletedAt).not.toBeNull();
});

it.each([401, 403, 500])(
  'keeps uncoded HTTP %s deletes pending with transcript intact',
  async (status) => {
    const { repo, note } = seedTeamMeeting();
    repo.deleteNote(note.id);
    mockDeleteRemoteNote.mockRejectedValue(Object.assign(new Error('Unavailable'), { status }));
    await expect(pushNotes()).rejects.toThrow('1 operation(s) failed');
    expect(repo.getPendingNotes()).toHaveLength(1);
    expect(repo.getAllNotes()).toHaveLength(0);
    expect(repo.getSegments(note.id)).toHaveLength(1);
  },
);

it('keeps managed audio while restoring a permission-denied deletion', async () => {
  const { repo, note } = seedTeamMeeting();
  const uri = `${FileSystem.documentDirectory}meeting-${note.id}.wav`;
  repo.updateNoteMeta(note.id, { sourceFile: uri });
  repo.deleteNote(note.id);
  mockDeleteRemoteNote.mockRejectedValue(
    Object.assign(new Error('Denied'), { status: 403, code: 'note_access_denied' }),
  );
  await expect(pushNotes()).resolves.toBeUndefined();
  expect(repo.getNoteById(note.id)?.sourceFile).toBe(uri);
  expect(FileSystem.deleteAsync).not.toHaveBeenCalled();
});

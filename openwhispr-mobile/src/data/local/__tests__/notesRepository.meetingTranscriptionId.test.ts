import {
  getMeetingTranscriptionId,
  meetingTranscriptionIdKey,
} from '@/lib/notes/meetingTranscriptionId';
import { LocalNotesRepository } from '../notesRepository';
import { createMemoryRepository } from './testDb';

it('reads the same meeting identity from a fresh repository after privacy and sync identity changes', () => {
  const { repo, db } = createMemoryRepository();
  const note = repo.createNote('Meeting', 'Keep these notes');
  const id = getMeetingTranscriptionId(repo, note.id);
  repo.setNotePrivacy(note.id, true);
  repo.setNotePrivacy(note.id, false);
  repo.clearNoteClientId(note.id);
  const reopened = new LocalNotesRepository(
    db as unknown as ConstructorParameters<typeof LocalNotesRepository>[0],
  );

  expect(getMeetingTranscriptionId(reopened, note.id)).toBe(id);
  expect(reopened.getNoteById(note.id)?.content).toBe('Keep these notes');
});

it('uses different identities for different recordings and identical note IDs in separate accounts', () => {
  const { repo: accountA } = createMemoryRepository();
  const { repo: accountB } = createMemoryRepository();
  const first = accountA.createNote('First', '');
  const second = accountA.createNote('Second', '');
  const otherAccount = accountB.createNote('Other account', '');
  expect(first.id).toBe(otherAccount.id);

  const ids = [
    getMeetingTranscriptionId(accountA, first.id),
    getMeetingTranscriptionId(accountA, second.id),
    getMeetingTranscriptionId(accountB, otherAccount.id),
  ];
  expect(new Set(ids).size).toBe(3);
  expect(getMeetingTranscriptionId(accountA, first.id)).toBe(ids[0]);
});

it.each(['deleteNote', 'hardDeleteNote', 'wipeAllSyncableData'] as const)(
  '%s removes saved meeting retry identities',
  (operation) => {
    const { repo } = createMemoryRepository();
    const note = repo.createNote('Meeting', '');
    getMeetingTranscriptionId(repo, note.id);

    repo[operation](note.id);

    expect(repo.getSyncState(meetingTranscriptionIdKey(note.id))).toBeNull();
  },
);

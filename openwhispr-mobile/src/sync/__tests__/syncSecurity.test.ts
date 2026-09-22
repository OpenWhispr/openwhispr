import { eq } from 'drizzle-orm';
import { dictionaryEntries, snippets } from '@/db/schema';
import { createMemoryRepository } from '@/data/local/__tests__/testDb';
import type { LocalNotesRepository } from '@/data/local/notesRepository';
import type { TestDb } from '@/data/local/__tests__/testDb';

let mockRepo: LocalNotesRepository;
let mockDatabase: TestDb;
jest.mock('@/data', () => ({
  get notesRepository() {
    return mockRepo;
  },
  spacesRepository: { getPrivateSpace: () => ({ id: 1 }), listSpaces: () => [] },
}));
jest.mock('@/db', () => ({
  get db() {
    return mockDatabase;
  },
}));
jest.mock('@/sync/syncEngine', () => ({ requestSync: jest.fn() }));
jest.mock('@sentry/react-native', () => ({
  addBreadcrumb: jest.fn(),
  captureMessage: jest.fn(),
  captureException: jest.fn(),
}));
jest.mock('@/data/remote/notesApi', () => ({
  batchCreateNotes: jest.fn(),
  updateNote: jest.fn(),
  deleteNote: jest.fn(),
  batchCreateFolders: jest.fn(),
  updateFolder: jest.fn(),
  fetchNotes: jest.fn(),
}));
jest.mock('@/data/remote/dictionaryApi', () => ({
  batchCreateDictionary: jest.fn(),
  updateDictionaryEntry: jest.fn(),
  deleteDictionaryEntry: jest.fn(),
}));
jest.mock('@/data/remote/snippetsApi', () => ({
  batchCreateSnippets: jest.fn(),
  updateSnippet: jest.fn(),
  deleteSnippet: jest.fn(),
}));

import { pushFolders } from '../pushFolders';
import { pushNotes } from '../pushNotes';
import { pullNotes } from '../pullNotes';
import { pushDictionary } from '../pushDictionary';
import { pushSnippets } from '../pushSnippets';
import {
  batchCreateNotes,
  batchCreateFolders,
  fetchNotes,
  updateNote,
} from '@/data/remote/notesApi';
import { batchCreateDictionary, deleteDictionaryEntry } from '@/data/remote/dictionaryApi';
import { batchCreateSnippets, deleteSnippet } from '@/data/remote/snippetsApi';
import { useDictionaryStore } from '@/store/useDictionaryStore';
import { useSnippetsStore } from '@/store/useSnippetsStore';
import { SyncCancelledError } from '../syncContext';

beforeEach(() => {
  jest.resetAllMocks();
  const memory = createMemoryRepository();
  mockRepo = memory.repo;
  mockDatabase = memory.db;
  useDictionaryStore.getState().reset();
  useSnippetsStore.getState().reset();
});

it('retains a folder rename made during creation and records the remote identity', async () => {
  const folder = mockRepo.createFolder('Before');
  mockRepo.setFolderClientId(folder.id, 'folder-client');
  jest.mocked(batchCreateFolders).mockImplementationOnce(async () => {
    mockRepo.renameFolder(folder.id, 'After');
    return [
      { id: 'remote-folder', client_folder_id: 'folder-client', updated_at: 'server-time' },
    ] as Awaited<ReturnType<typeof batchCreateFolders>>;
  });
  await pushFolders();
  expect(mockRepo.getFolders().find((row) => row.id === folder.id)).toMatchObject({
    name: 'After',
    pendingSync: 1,
    remoteId: 'remote-folder',
  });
});

it('retains dictionary edits made during upload', async () => {
  const row = mockDatabase
    .insert(dictionaryEntries)
    .values({ word: 'Before', source: 'manual', clientDictId: 'dict-client', pendingSync: 1 })
    .returning()
    .get();
  jest.mocked(batchCreateDictionary).mockImplementationOnce(async () => {
    mockDatabase
      .update(dictionaryEntries)
      .set({ word: 'After' })
      .where(eq(dictionaryEntries.id, row.id))
      .run();
    return [
      { id: 'remote-dict', client_dict_id: 'dict-client', updated_at: 'server-time' },
    ] as Awaited<ReturnType<typeof batchCreateDictionary>>;
  });
  await pushDictionary();
  expect(mockDatabase.select().from(dictionaryEntries).get()).toMatchObject({
    word: 'After',
    pendingSync: 1,
    remoteId: 'remote-dict',
  });
});

it.each(['removeWord', 'clearAll'] as const)(
  'sends a dictionary deletion made with %s during its first upload',
  async (operation) => {
    useDictionaryStore.getState().addWords('DeleteMe');
    jest.mocked(batchCreateDictionary).mockImplementationOnce(async ([entry]) => {
      if (operation === 'clearAll') useDictionaryStore.getState().clearAll();
      else useDictionaryStore.getState().removeWord('DeleteMe');
      return [
        {
          ...entry,
          id: 'remote-dict',
          deleted_at: null,
          created_at: '2026-09-17T10:00:00.000Z',
          updated_at: '2026-09-17T10:00:01.000Z',
        },
      ];
    });

    await pushDictionary();

    expect(useDictionaryStore.getState().entries).toEqual([]);
    expect(mockDatabase.select().from(dictionaryEntries).get()).toMatchObject({
      deletedAt: expect.any(String),
      pendingSync: 1,
      remoteId: 'remote-dict',
    });

    await pushDictionary();

    expect(deleteDictionaryEntry).toHaveBeenCalledWith('remote-dict');
    expect(mockDatabase.select().from(dictionaryEntries).all()).toEqual([]);
  },
);

it('sends a snippet deletion made through the store during its first upload', async () => {
  useSnippetsStore.getState().addSnippet(';test', 'Before');
  jest.mocked(batchCreateSnippets).mockImplementationOnce(async ([entry]) => {
    useSnippetsStore.getState().removeSnippet(';test');
    return [
      {
        ...entry,
        id: 'remote-snippet',
        deleted_at: null,
        created_at: '2026-09-17T10:00:00.000Z',
        updated_at: '2026-09-17T10:00:01.000Z',
      },
    ];
  });

  await pushSnippets();

  expect(useSnippetsStore.getState().entries).toEqual([]);
  expect(mockDatabase.select().from(snippets).get()).toMatchObject({
    deletedAt: expect.any(String),
    pendingSync: 1,
    remoteId: 'remote-snippet',
  });

  await pushSnippets();

  expect(deleteSnippet).toHaveBeenCalledWith('remote-snippet');
  expect(mockDatabase.select().from(snippets).all()).toEqual([]);
});

it('cleans up dictionary entries and snippets deleted before any upload without API writes', async () => {
  useDictionaryStore.getState().addWords('DeleteMe');
  useDictionaryStore.getState().removeWord('DeleteMe');
  useSnippetsStore.getState().addSnippet(';test', 'Before');
  useSnippetsStore.getState().removeSnippet(';test');

  await pushDictionary();
  await pushSnippets();

  expect(mockDatabase.select().from(dictionaryEntries).all()).toEqual([]);
  expect(mockDatabase.select().from(snippets).all()).toEqual([]);
  expect(batchCreateDictionary).not.toHaveBeenCalled();
  expect(batchCreateSnippets).not.toHaveBeenCalled();
  expect(deleteDictionaryEntry).not.toHaveBeenCalled();
  expect(deleteSnippet).not.toHaveBeenCalled();
});

it('does not apply a stale pull response or advance its cursor after an account switch', async () => {
  let switched = false;
  jest.mocked(fetchNotes).mockImplementationOnce(async () => {
    switched = true;
    return {
      notes: [
        { id: 'other-user-note', content: 'Private', title: 'Private', updated_at: 'server-time' },
      ],
      hasMore: false,
    } as Awaited<ReturnType<typeof fetchNotes>>;
  });
  await expect(
    pullNotes(() => {
      if (switched) throw new SyncCancelledError();
    }),
  ).rejects.toThrow(SyncCancelledError);
  expect(mockRepo.getAllNotes()).toEqual([]);
  expect(mockRepo.getSyncState('notes.cursor')).toBeNull();
});

it('does not acknowledge an old account upload into a replacement local database', async () => {
  const note = mockRepo.createNote('Before', 'private');
  mockRepo.setNoteClientId(note.id, 'client');
  let switched = false;
  jest.mocked(batchCreateNotes).mockImplementationOnce(async () => {
    switched = true;
    mockRepo.wipeAllSyncableData();
    mockRepo.createNote('New account', 'different');
    return [{ id: 'old-account-remote', client_note_id: 'client' }];
  });
  await expect(
    pushNotes(false, () => {
      if (switched) throw new SyncCancelledError();
    }),
  ).rejects.toThrow(SyncCancelledError);
  expect(mockRepo.getAllNotes()[0]).toMatchObject({ title: 'New account', remoteId: null });
});

it('stops the next batch after backup is disabled, while acknowledging the sent batch', async () => {
  for (let index = 0; index < 51; index += 1) {
    const note = mockRepo.createNote(`Note ${index}`, 'private');
    mockRepo.setNoteClientId(note.id, `client-${index}`);
  }
  let disabled = false;
  jest.mocked(batchCreateNotes).mockImplementationOnce(async (rows) => {
    disabled = true;
    return rows.map((row, index) => ({
      id: `remote-${index}`,
      client_note_id: row.client_note_id,
    }));
  });
  await expect(
    pushNotes(false, (upload) => {
      if (upload && disabled) throw new SyncCancelledError();
    }),
  ).rejects.toThrow(SyncCancelledError);
  expect(batchCreateNotes).toHaveBeenCalledTimes(1);
  expect(mockRepo.getPendingNotes()).toHaveLength(1);
});

it('does not upload a queued note made private during an earlier request', async () => {
  const first = mockRepo.createNote('First', 'first');
  const second = mockRepo.createNote('Second', 'secret');
  mockRepo.setNoteClientId(first.id, 'first');
  mockRepo.setNoteClientId(second.id, 'second');
  mockRepo.markNotePushed(mockRepo.getNoteById(first.id)!, 'remote-first', 'base');
  mockRepo.markNotePushed(mockRepo.getNoteById(second.id)!, 'remote-second', 'base');
  mockRepo.updateNote(first.id, { content: 'changed' });
  mockRepo.updateNote(second.id, { content: 'changed secret' });
  jest.mocked(updateNote).mockImplementationOnce(async () => {
    mockRepo.setNotePrivacy(second.id, true);
    return { id: 'remote-first', updated_at: 'server-time' } as Awaited<
      ReturnType<typeof updateNote>
    >;
  });
  await pushNotes();
  expect(updateNote).toHaveBeenCalledTimes(1);
});

it('does not attach a mismatched identified batch response to a different local note', async () => {
  const created = mockRepo.createNote('Keep', 'pending');
  mockRepo.setNoteClientId(created.id, 'expected-client');
  jest
    .mocked(batchCreateNotes)
    .mockResolvedValueOnce([{ id: 'unrelated', client_note_id: 'different-client' }]);
  await pushNotes();
  expect(mockRepo.getNoteById(created.id)).toMatchObject({ remoteId: null, pendingSync: 1 });
});

it('does not process an old account rejection against new local work', async () => {
  const created = mockRepo.createNote('Keep', 'pending');
  mockRepo.setNoteClientId(created.id, 'client');
  let switched = false;
  jest.mocked(batchCreateNotes).mockImplementationOnce(async () => {
    switched = true;
    throw { status: 400 };
  });
  await expect(
    pushNotes(false, () => {
      if (switched) throw new SyncCancelledError();
    }),
  ).rejects.toThrow(SyncCancelledError);
  expect(mockRepo.getNoteById(created.id)!.pendingSync).toBe(1);
});

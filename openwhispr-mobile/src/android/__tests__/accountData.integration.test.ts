import Database from 'better-sqlite3';
import type { Folder } from '@/data/types';

const mockFiles = new Map<string, InstanceType<typeof Database>>();
const mockDeleteAudio = jest.fn().mockResolvedValue(undefined);
const mockReadAudio = jest.fn().mockResolvedValue(['meeting-81.wav']);
const mockRunChatTurn = jest.fn();
let mockSessionUser: { id: string; email: string; isAnonymous?: boolean } | null = null;
let mockSessionFailure: Error | null = null;

jest.mock('expo-sqlite', () => ({
  openDatabaseSync: (name: string) => {
    let raw = mockFiles.get(name);
    if (!raw) {
      raw = new (require('better-sqlite3'))(':memory:');
      mockFiles.set(name, raw!);
    }
    return {
      raw,
      execSync: (sql: string) => raw!.exec(sql),
      runSync: (sql: string, ...params: unknown[]) => {
        const result = raw!.prepare(sql).run(...params);
        return { changes: result.changes, lastInsertRowId: Number(result.lastInsertRowid) };
      },
      getAllSync: (sql: string, ...params: unknown[]) => raw!.prepare(sql).all(...params),
      getFirstSync: (sql: string, ...params: unknown[]) => raw!.prepare(sql).get(...params),
      withTransactionSync: (run: () => void) => raw!.transaction(run)(),
      closeSync: () => {},
    };
  },
}));
jest.mock('drizzle-orm/expo-sqlite', () => ({
  drizzle: (connection: { raw: InstanceType<typeof Database> }, options: unknown) =>
    require('drizzle-orm/better-sqlite3').drizzle(connection.raw, options),
}));
jest.mock('expo-sqlite/localStorage/install', () => ({}));
jest.mock('expo-router', () => ({ router: { push: jest.fn() } }));
jest.mock('../../../modules/android-dictation/src', () => ({
  AndroidDictation: null,
  dictationEvents: null,
}));
jest.mock('expo-file-system/legacy', () => ({
  documentDirectory: 'file:///docs/',
  deleteAsync: (...args: unknown[]) => mockDeleteAudio(...args),
  readDirectoryAsync: (...args: unknown[]) => mockReadAudio(...args),
  getInfoAsync: async () => ({ exists: true }),
}));
jest.mock('expo-secure-store', () => ({
  getItemAsync: async () => null,
  setItemAsync: async () => {},
  deleteItemAsync: async () => {},
}));
jest.mock('@/lib/authClient', () => ({
  getStoredSession: async () => (mockSessionUser ? `test-${mockSessionUser.id}` : null),
  getSession: async () => {
    if (mockSessionFailure) throw mockSessionFailure;
    return mockSessionUser;
  },
  clearSession: async () => {},
  initAuthenticatedUser: async () => {},
  signInWithEmail: async (id: string) => {
    mockSessionUser = { id, email: `${id}@example.invalid` };
    return { user: mockSessionUser, sessionCookie: `test-${id}` };
  },
  signOut: async () => {
    mockSessionUser = null;
  },
  deleteAccount: async () => {
    mockSessionUser = null;
  },
}));
jest.mock('@/lib/sentry', () => ({
  Sentry: { addBreadcrumb: jest.fn(), captureException: jest.fn() },
}));
jest.mock('@sentry/react-native', () => ({
  addBreadcrumb: jest.fn(),
  captureException: jest.fn(),
}));
jest.mock('@/lib/notes/noteShareTokens', () => ({
  claimNoteShareTokens: async () => {},
  clearNoteShareTokens: async () => {},
}));
jest.mock('@/services/providers/ProviderCredentials', () => ({
  clearProviderCredentials: async () => {},
}));
jest.mock('@/services/agent/AgentComposerService', () => ({ clearAllSessions: jest.fn() }));
jest.mock('@/lib/chat/runChatTurn', () => ({
  runChatTurn: (...args: unknown[]) => mockRunChatTurn(...args),
}));
jest.mock('@/store/useUsageStore', () => ({
  useUsageStore: { getState: () => ({ reset: jest.fn() }) },
}));
jest.mock('@/store/useConfigStore', () => ({
  useConfigStore: {
    getState: () => ({ config: { cloudBackupEnabled: false } }),
    subscribe: () => () => {},
  },
}));
// Exercise the real collection stores during startup and account switches.
jest.mock('@/lib/apiClient', () => ({
  ApiError: class extends Error {},
  isPolicyCloudBackupBlockedError: () => false,
}));
jest.mock('@/sync/privateNoteDeletion', () => ({
  pushPrivateNoteDeletes: async () => {},
  clearPrivateNoteDeletionQueue: jest.fn(),
}));
jest.mock('@/sync/syncSpaces', () => ({
  syncSpaces: async () => ({ capable: false, activeSpaces: [] }),
}));

beforeEach(() => {
  jest.resetModules();
  jest.clearAllMocks();
  mockDeleteAudio.mockReset().mockResolvedValue(undefined);
  mockReadAudio.mockReset().mockResolvedValue(['meeting-81.wav']);
  mockRunChatTurn.mockReset();
  mockFiles.clear();
  mockSessionUser = { id: 'account-a', email: 'a@example.invalid' };
  mockSessionFailure = null;
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        values.set(key, value);
      },
      removeItem: (key: string) => {
        values.delete(key);
      },
    },
  });
  require('react-native').Platform.OS = 'android';
});

it("does not sweep another account's meeting recordings after restoring a different account", async () => {
  require('@/db/migrate').runMigrations();
  const legacy = mockFiles.get('openwhispr_notes.db')!;
  legacy.exec("INSERT INTO sync_state(key, value) VALUES ('sync.user_id', 'account-a')");
  mockSessionUser = { id: 'account-b', email: 'b@example.invalid' };
  await require('@/store/useAuthStore').useAuthStore.getState().initialize();
  const { LocalMeetingRecorder } = require('../LocalMeetingRecorder');
  expect(new LocalMeetingRecorder(81, () => {}).uri).toMatch(
    /^file:\/\/\/docs\/account-audio\/[0-9a-f-]{36}\/meeting-81\.wav$/,
  );
  require('@/lib/meetingRecovery').startMeetingRecoveryOnce();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(mockReadAudio).not.toHaveBeenCalledWith('file:///docs/');
  expect(mockDeleteAudio).not.toHaveBeenCalledWith(
    'file:///docs/meeting-81.wav',
    expect.anything(),
  );
});

it('keeps the original local collection separate from both signed-in accounts', async () => {
  require('@/db/migrate').runMigrations();
  const legacy = mockFiles.get('openwhispr_notes.db')!;
  legacy.exec("INSERT INTO notes(id, content, is_private) VALUES (81, 'Local-only text', 1)");
  mockSessionUser = null;
  const { useAuthStore } = require('@/store/useAuthStore');
  const { notesRepository } = require('@/data');
  await useAuthStore.getState().initialize();
  for (const id of ['account-a', 'account-b']) {
    await useAuthStore.getState().signIn(id, 'synthetic');
    expect(notesRepository.getAllNotes()).toHaveLength(0);
    await useAuthStore.getState().signOut();
    expect(notesRepository.getNoteById(81)?.content).toBe('Local-only text');
  }
});

it('keeps a new Local note visible after a stale account folder is selected and another account is visited', async () => {
  require('@/db/migrate').runMigrations();
  const { useAuthStore } = require('@/store/useAuthStore');
  const { useNotesStore } = require('@/store/useNotesStore');
  const { notesRepository } = require('@/data');
  await useAuthStore.getState().initialize();
  let oldFolder: Folder = notesRepository.createFolder('A first folder');
  for (let index = 0; index < 5; index += 1)
    oldFolder = notesRepository.createFolder(`A folder ${index}`);
  notesRepository.createNote('A only', 'Account A body', oldFolder.id);
  await useAuthStore.getState().signOut();
  const localDefault = notesRepository
    .getPrivateFolders()
    .find((folder: { isDefault: number }) => folder.isDefault);
  expect(
    notesRepository.getFolders().some((folder: { id: number }) => folder.id === oldFolder.id),
  ).toBe(false);
  useNotesStore.getState().setActiveFolderId(oldFolder.id);
  const created = useNotesStore.getState().createNote('Local fixture', 'Exact Local fixture body');
  expect(created.folderId).toBe(localDefault.id);
  expect(useNotesStore.getState().activeFolderId).toBe(localDefault.id);
  expect(
    notesRepository.getNotesByFolder(localDefault.id).map((note: { id: number }) => note.id),
  ).toContain(created.id);
  await useAuthStore.getState().signIn('account-b', 'synthetic');
  expect(notesRepository.searchNotes('Exact Local fixture body')).toHaveLength(0);
  await useAuthStore.getState().signOut();
  expect(
    notesRepository
      .getNotesByFolder(localDefault.id)
      .find((note: { id: number }) => note.id === created.id)?.content,
  ).toBe('Exact Local fixture body');
  expect(notesRepository.searchNotes('Account A body')).toHaveLength(0);
});

it('keeps saved chats with Local, A and B while clearing the previous account from the screen', async () => {
  require('@/db/migrate').runMigrations();
  mockSessionUser = null;
  const { useAuthStore } = require('@/store/useAuthStore');
  const { useChatStore } = require('@/store/useChatStore');
  const { chatRepository } = require('@/data');
  await useAuthStore.getState().initialize();
  const local = chatRepository.createConversation('Local chat');
  useChatStore.getState().openConversation(local.id);
  await useAuthStore.getState().signIn('account-a', 'synthetic');
  expect(useChatStore.getState().activeConversationId).toBeNull();
  expect(chatRepository.listConversations()).toEqual([]);
  const accountA = chatRepository.createConversation('A chat');
  useChatStore.getState().openConversation(accountA.id);
  await useAuthStore.getState().signIn('account-b', 'synthetic');
  expect(useChatStore.getState()).toMatchObject({ activeConversationId: null, messages: [] });
  expect(chatRepository.listConversations()).toEqual([]);
  chatRepository.createConversation('B chat');
  await useAuthStore.getState().signOut();
  expect(chatRepository.listConversations().map((chat: { title: string }) => chat.title)).toEqual([
    'Local chat',
  ]);
  for (const [id, title] of [
    ['account-a', 'A chat'],
    ['account-b', 'B chat'],
  ]) {
    await useAuthStore.getState().signIn(id, 'synthetic');
    expect(chatRepository.listConversations().map((chat: { title: string }) => chat.title)).toEqual(
      [title],
    );
    await useAuthStore.getState().signOut();
  }
});

it('abandons an in-flight chat before switching databases and never saves its late answer', async () => {
  require('@/db/migrate').runMigrations();
  const { useAuthStore } = require('@/store/useAuthStore');
  const { useChatStore } = require('@/store/useChatStore');
  const { chatRepository } = require('@/data');
  await useAuthStore.getState().initialize();
  let finish!: (value: { text: string; steps: []; sources: [] }) => void;
  mockRunChatTurn.mockReturnValue(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  const pending = useChatStore.getState().send('A private question', {
    conversationId: null,
    allowCloudFallback: false,
  });
  const signal = mockRunChatTurn.mock.calls[0][0].signal as AbortSignal;
  await useAuthStore.getState().signIn('account-b', 'synthetic');
  expect(signal.aborted).toBe(true);
  finish({ text: 'A private answer', steps: [], sources: [] });
  await pending.done;
  expect(chatRepository.listConversations()).toEqual([]);
  expect(useChatStore.getState()).toMatchObject({ messages: [], pending: null });
  await useAuthStore.getState().signIn('account-a', 'synthetic');
  expect(
    chatRepository
      .getMessages(pending.conversationId)
      .map((message: { text: string }) => message.text),
  ).toEqual(['A private question']);
});

it('deletes only the deleted account chats and keeps the Local chat it returns to', async () => {
  require('@/db/migrate').runMigrations();
  mockSessionUser = null;
  const { useAuthStore } = require('@/store/useAuthStore');
  const { chatRepository } = require('@/data');
  await useAuthStore.getState().initialize();
  chatRepository.createConversation('Keep Local chat');
  await useAuthStore.getState().signIn('account-a', 'synthetic');
  chatRepository.createConversation('Delete A chat');
  const accountA = require('@/db').db.$client;
  await useAuthStore.getState().deleteAccount();
  expect(accountA.prepare('SELECT * FROM chat_conversations').all()).toEqual([]);
  expect(chatRepository.listConversations().map((chat: { title: string }) => chat.title)).toEqual([
    'Keep Local chat',
  ]);
});

it('erases only the deleted account collection and returns to the retained Local collection', async () => {
  require('@/db/migrate').runMigrations();
  const legacy = mockFiles.get('openwhispr_notes.db')!;
  legacy.exec("INSERT INTO notes(id, content) VALUES (81, 'Local text')");
  mockSessionUser = null;
  const { useAuthStore } = require('@/store/useAuthStore');
  const { notesRepository } = require('@/data');
  await useAuthStore.getState().initialize();
  await useAuthStore.getState().signIn('account-a', 'synthetic');
  const { db } = require('@/db');
  db.$client.exec("INSERT INTO notes(id, content) VALUES (81, 'Account A text')");
  const accountA = db.$client;
  await useAuthStore.getState().deleteAccount();
  expect(accountA.prepare('SELECT content FROM notes').all()).toEqual([]);
  expect(notesRepository.getNoteById(81)?.content).toBe('Local text');
  expect(useAuthStore.getState().user).toBeNull();
});

it('retains unsynced private data when reauthenticating without signing out', async () => {
  require('@/db/migrate').runMigrations();
  const legacy = mockFiles.get('openwhispr_notes.db')!;
  legacy.exec(`
    INSERT INTO sync_state(key, value) VALUES ('sync.user_id', 'account-a');
    INSERT INTO notes(id, content, is_private, source_file)
      VALUES (81, 'Keep this private transcript', 1, 'file:///docs/meeting-81.wav');
    INSERT INTO dictionary_entries(word, source) VALUES ('Retainedword', 'manual');
    INSERT INTO snippets(trigger, replacement) VALUES ('retained', 'Retain this snippet');
  `);
  const { useAuthStore } = require('@/store/useAuthStore');
  const { notesRepository } = require('@/data');
  await useAuthStore.getState().initialize();
  await useAuthStore.getState().signIn('account-a', 'synthetic');

  expect(notesRepository.getNoteById(81)).toMatchObject({
    content: 'Keep this private transcript',
    isPrivate: 1,
    sourceFile: 'file:///docs/meeting-81.wav',
  });
  expect(legacy.prepare('SELECT word FROM dictionary_entries').all()).toEqual([
    { word: 'Retainedword' },
  ]);
  expect(legacy.prepare('SELECT replacement FROM snippets').all()).toEqual([
    { replacement: 'Retain this snippet' },
  ]);
  expect(mockDeleteAudio).not.toHaveBeenCalled();
});

it("restores account ownership after a process restart without importing another account's data", async () => {
  require('@/db/migrate').runMigrations();
  const legacy = mockFiles.get('openwhispr_notes.db')!;
  legacy.exec(
    "INSERT INTO sync_state(key, value) VALUES ('sync.user_id', 'account-a'); INSERT INTO notes(id, content) VALUES (81, 'Account A text')",
  );
  await require('@/store/useAuthStore').useAuthStore.getState().initialize();
  await require('@/store/useAuthStore').useAuthStore.getState().signIn('account-b', 'synthetic');
  jest.resetModules();
  require('react-native').Platform.OS = 'android';
  await require('@/store/useAuthStore').useAuthStore.getState().initialize();
  const { notesRepository } = require('@/data');
  expect(notesRepository.getAllNotes()).toHaveLength(0);
  await require('@/store/useAuthStore').useAuthStore.getState().signIn('account-a', 'synthetic');
  expect(notesRepository.getNoteById(81)?.content).toBe('Account A text');
});

it('fails closed when persisting account ownership fails, keeping the old collection intact', async () => {
  require('@/db/migrate').runMigrations();
  const legacy = mockFiles.get('openwhispr_notes.db')!;
  legacy.exec(
    "INSERT INTO sync_state(key, value) VALUES ('sync.user_id', 'account-a'); INSERT INTO notes(id, content) VALUES (81, 'Keep me')",
  );
  const { useAuthStore } = require('@/store/useAuthStore');
  const { notesRepository } = require('@/data');
  await useAuthStore.getState().initialize();
  const before = localStorage.getItem('android.local-accounts.v1');
  const write = jest.spyOn(localStorage, 'setItem').mockImplementation(() => {
    throw new Error('Disk full');
  });
  await useAuthStore.getState().signIn('account-b', 'synthetic');
  expect(useAuthStore.getState().user).toBeNull();
  expect(() => notesRepository.getAllNotes()).toThrow('Local account data is unavailable');
  expect(legacy.prepare('SELECT content FROM notes WHERE id = 81').get()).toEqual({
    content: 'Keep me',
  });
  expect(localStorage.getItem('android.local-accounts.v1')).toBe(before);
  write.mockRestore();
});

it('blocks database reads when saved ownership cannot be read on a cold start', async () => {
  require('@/db/migrate').runMigrations();
  const legacy = mockFiles.get('openwhispr_notes.db')!;
  legacy.exec("INSERT INTO notes(id, content) VALUES (81, 'Keep this private collection')");
  localStorage.setItem('android.local-accounts.v1', '{broken');
  await expect(
    require('@/store/useAuthStore').useAuthStore.getState().initialize(),
  ).rejects.toBeInstanceOf(SyntaxError);
  const { notesRepository } = require('@/data');
  expect(() => notesRepository.getAllNotes()).toThrow('Local account data is unavailable');
  expect(require('../accountData').useAccountData.getState().error).toBeTruthy();
  expect(legacy.prepare('SELECT content FROM notes WHERE id = 81').get()).toEqual({
    content: 'Keep this private collection',
  });
});

it('preserves the original Android startup error and retries without opening the wrong collection', async () => {
  require('@/db/migrate').runMigrations();
  const legacy = mockFiles.get('openwhispr_notes.db')!;
  legacy.exec(
    "INSERT INTO sync_state(key, value) VALUES ('sync.user_id', 'account-a'); INSERT INTO notes(id, content) VALUES (81, 'Keep this account note')",
  );
  const { useAuthStore } = require('@/store/useAuthStore');
  const { notesRepository } = require('@/data');
  const failure = new Error('Session initialization failed');
  mockSessionFailure = failure;
  await expect(useAuthStore.getState().initialize()).rejects.toBe(failure);
  expect(useAuthStore.getState()).toMatchObject({ isInitialized: true, isLoading: false });
  expect(require('../accountData').useAccountData.getState().blocked).toBe(true);
  expect(() => notesRepository.getAllNotes()).toThrow('Local account data is unavailable');
  expect(legacy.prepare('SELECT content FROM notes WHERE id = 81').get()).toEqual({
    content: 'Keep this account note',
  });

  mockSessionFailure = null;
  await useAuthStore.getState().initialize();
  expect(require('../accountData').useAccountData.getState()).toMatchObject({
    owner: 'account:account-a',
    blocked: false,
    error: null,
  });
  expect(notesRepository.getNoteById(81)?.content).toBe('Keep this account note');
});

it('retains the existing iOS initialization fallback when its session request fails', async () => {
  require('react-native').Platform.OS = 'ios';
  mockSessionFailure = new Error('Session initialization failed');
  const { useAuthStore } = require('@/store/useAuthStore');
  await expect(useAuthStore.getState().initialize()).resolves.toBeUndefined();
  expect(useAuthStore.getState()).toMatchObject({ isInitialized: true, isLoading: false });
});

it('preserves both collections when an anonymous link collides with an existing account', async () => {
  require('@/db/migrate').runMigrations();
  const { selectAccountData } = require('../accountData');
  const { db } = require('@/db');
  selectAccountData({ id: 'account-a' });
  db.$client.exec("INSERT INTO notes(id, content) VALUES (81, 'Account A text')");
  const accountA = db.$client;
  selectAccountData({ id: 'anonymous', isAnonymous: true });
  db.$client.exec("INSERT INTO notes(id, content) VALUES (81, 'Anonymous text')");
  const anonymous = db.$client;
  expect(() => selectAccountData({ id: 'account-a' })).toThrow(
    'Both accounts have saved local data',
  );
  expect(accountA.prepare('SELECT content FROM notes WHERE id = 81').get()).toEqual({
    content: 'Account A text',
  });
  expect(anonymous.prepare('SELECT content FROM notes WHERE id = 81').get()).toEqual({
    content: 'Anonymous text',
  });
  expect(() => require('@/data').notesRepository.getAllNotes()).toThrow(
    'Local account data is unavailable',
  );
});

afterEach(() => {
  require('@/sync/syncEngine').teardownSyncTriggers();
  for (const raw of mockFiles.values()) raw.close();
  Reflect.deleteProperty(globalThis, 'localStorage');
});

it('keeps unsynced private notes and their related data across A → B → A with backup off', async () => {
  require('@/db/migrate').runMigrations();
  const legacy = mockFiles.get('openwhispr_notes.db')!;
  legacy.exec(`
    INSERT INTO sync_state(key, value) VALUES ('sync.user_id', 'account-a');
    INSERT INTO notes(id, title, content, folder_id, note_type, is_private, source_file)
      VALUES (81, 'Private meeting', 'Retain this transcript', 2, 'meeting', 1, 'file:///docs/meeting-81.wav');
    INSERT INTO dictionary_entries(word, source) VALUES ('Retainedword', 'manual');
    INSERT INTO snippets(trigger, replacement) VALUES ('retained', 'Retain this snippet');
    INSERT INTO speaker_profiles(display_name, embedding, consent_at) VALUES ('Consenting voice', x'0000803f', '2026-01-01');
  `);
  const { useAuthStore } = require('@/store/useAuthStore');
  const { notesRepository } = require('@/data');
  const { initSyncTriggers, requestSync } = require('@/sync/syncEngine');
  await useAuthStore.getState().initialize();
  initSyncTriggers();
  expect(notesRepository.getNoteById(81)?.content).toBe('Retain this transcript');

  await useAuthStore.getState().signOut();
  await useAuthStore.getState().signIn('account-b', 'synthetic');
  await requestSync('sign-in');
  expect(notesRepository.getAllNotes()).toHaveLength(0);
  expect(legacy.prepare('SELECT content FROM notes WHERE id = 81').get()).toEqual({
    content: 'Retain this transcript',
  });

  await useAuthStore.getState().signOut();
  await useAuthStore.getState().signIn('account-a', 'synthetic');
  await requestSync('sign-in');
  expect(notesRepository.getNoteById(81)).toMatchObject({
    title: 'Private meeting',
    content: 'Retain this transcript',
    isPrivate: 1,
    sourceFile: 'file:///docs/meeting-81.wav',
  });
  expect(legacy.prepare('SELECT word FROM dictionary_entries').all()).toEqual([
    { word: 'Retainedword' },
  ]);
  expect(legacy.prepare('SELECT replacement FROM snippets').all()).toEqual([
    { replacement: 'Retain this snippet' },
  ]);
  expect(mockDeleteAudio).not.toHaveBeenCalled();
  expect(
    legacy.prepare('SELECT display_name, hex(embedding) AS embedding FROM speaker_profiles').all(),
  ).toEqual([{ display_name: 'Consenting voice', embedding: '0000803F' }]);
  await useAuthStore.getState().signOut();
  expect(notesRepository.getAllNotes()).toHaveLength(0);
});

it('links anonymous local data once without changing its audio ownership', async () => {
  require('@/db/migrate').runMigrations();
  const legacy = mockFiles.get('openwhispr_notes.db')!;
  legacy.exec(
    "INSERT INTO sync_state(key, value) VALUES ('sync.user_id', 'anon'), ('sync.anonymous_user_id', 'anon'); INSERT INTO notes(id, content, remote_id, is_private, source_file) VALUES (81, 'Anonymous text', 'old-remote', 1, 'file:///docs/meeting-81.wav')",
  );
  mockSessionUser = { id: 'anon', email: 'anon@example.invalid', isAnonymous: true };
  const { useAuthStore } = require('@/store/useAuthStore');
  const { notesRepository } = require('@/data');
  const { initSyncTriggers, requestSync } = require('@/sync/syncEngine');
  await useAuthStore.getState().initialize();
  initSyncTriggers();
  await useAuthStore.getState().signIn('account-a', 'synthetic');
  await requestSync('sign-in');
  expect(notesRepository.getNoteById(81)).toMatchObject({
    content: 'Anonymous text',
    remoteId: null,
    sourceFile: 'file:///docs/meeting-81.wav',
  });
  expect(notesRepository.getSyncState('sync.user_id')).toBe('account-a');
  expect(notesRepository.getSyncState('sync.anonymous_user_id')).toBeNull();
  await useAuthStore.getState().signOut();
  await useAuthStore.getState().signIn('account-b', 'synthetic');
  expect(notesRepository.getAllNotes()).toHaveLength(0);
  await useAuthStore.getState().signIn('account-a', 'synthetic');
  expect(notesRepository.getNoteById(81)?.content).toBe('Anonymous text');
});

it('never revives a pending sync checkpoint after A → B → A', async () => {
  require('@/db/migrate').runMigrations();
  const { useAuthStore } = require('@/store/useAuthStore');
  await useAuthStore.getState().initialize();
  const context = require('@/sync/createSyncContext').createSyncContext();
  await useAuthStore.getState().signIn('account-b', 'synthetic');
  await useAuthStore.getState().signIn('account-a', 'synthetic');
  expect(() => context.checkpoint()).toThrow('Sync context changed');
  context.dispose();
});

it('does not delete audio when an old directory scan resolves after an account switch', async () => {
  require('@/db/migrate').runMigrations();
  const legacy = mockFiles.get('openwhispr_notes.db')!;
  legacy.exec("INSERT INTO sync_state(key, value) VALUES ('sync.user_id', 'account-a')");
  const { useAuthStore } = require('@/store/useAuthStore');
  await useAuthStore.getState().initialize();
  let resolveFiles!: (files: string[]) => void;
  mockReadAudio.mockReturnValueOnce(
    new Promise<string[]>((resolve) => {
      resolveFiles = resolve;
    }),
  );
  require('@/lib/meetingRecovery').startMeetingRecoveryOnce();
  await Promise.resolve();
  await useAuthStore.getState().signIn('account-b', 'synthetic');
  resolveFiles(['meeting-81.wav']);
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(mockDeleteAudio).not.toHaveBeenCalled();
});

it('retries interrupted account audio erasure before reopening local content', async () => {
  require('@/db/migrate').runMigrations();
  const legacy = mockFiles.get('openwhispr_notes.db')!;
  legacy.exec(
    "INSERT INTO sync_state(key, value) VALUES ('sync.user_id', 'account-a'); INSERT INTO notes(id, source_file) VALUES (81, 'file:///docs/meeting-81.wav')",
  );
  const { useAuthStore } = require('@/store/useAuthStore');
  await useAuthStore.getState().initialize();
  mockDeleteAudio.mockRejectedValueOnce(new Error('Storage busy'));
  await expect(useAuthStore.getState().deleteAccount()).rejects.toThrow('Storage busy');
  expect(require('../accountData').useAccountData.getState().blocked).toBe(true);
  await useAuthStore.getState().initialize();
  expect(useAuthStore.getState().user).toBeNull();
  expect(mockDeleteAudio).toHaveBeenCalledTimes(2);
  const account = JSON.parse(localStorage.getItem('android.local-accounts.v1')!).accounts.find(
    (entry: { owner: string }) => entry.owner === 'account:account-a',
  );
  expect(account).toMatchObject({ deleted: true, erasureComplete: true, pendingAudio: [] });
});

it('cold startup opens retained Local content through the real data stores', async () => {
  require('@/db/migrate').runMigrations();
  const legacy = mockFiles.get('openwhispr_notes.db')!;
  legacy.exec(`
    INSERT INTO notes(id, title, content, folder_id) VALUES (81, 'Local fixture', 'Keep this Local note.', 1);
    INSERT INTO dictionary_entries(word, source) VALUES ('LocalFixture', 'manual');
    INSERT INTO snippets(trigger, replacement) VALUES ('local fixture', 'Keep this Local snippet.');
  `);
  mockSessionUser = null;
  const { useAuthStore } = require('@/store/useAuthStore');
  await useAuthStore.getState().initialize();
  expect(require('../accountData').useAccountData.getState()).toMatchObject({
    owner: 'local',
    blocked: false,
    error: null,
  });
  const { useNotesStore } = require('@/store/useNotesStore');
  const { useDictionaryStore } = require('@/store/useDictionaryStore');
  const { useSnippetsStore } = require('@/store/useSnippetsStore');
  expect(useNotesStore.getState().notes).toEqual([
    expect.objectContaining({ title: 'Local fixture', content: 'Keep this Local note.' }),
  ]);
  expect(useDictionaryStore.getState().entries).toEqual([
    expect.objectContaining({ word: 'LocalFixture', source: 'manual' }),
  ]);
  expect(useSnippetsStore.getState().entries).toEqual([
    { trigger: 'local fixture', replacement: 'Keep this Local snippet.' },
  ]);
});

it('retains the legacy collection for its recorded account when upgrading while signed out', async () => {
  require('@/db/migrate').runMigrations();
  const legacy = mockFiles.get('openwhispr_notes.db')!;
  legacy.exec(`
    INSERT INTO sync_state(key, value) VALUES ('sync.user_id', 'account-a');
    INSERT INTO notes(id, title, content, folder_id) VALUES (81, 'Retained fixture', 'Keep this legacy note.', 1);
    INSERT INTO dictionary_entries(word, source) VALUES ('RetainedFixture', 'manual');
    INSERT INTO snippets(trigger, replacement) VALUES ('retained fixture', 'Keep this legacy snippet.');
  `);
  mockSessionUser = null;
  const { useAuthStore } = require('@/store/useAuthStore');
  const { useNotesStore } = require('@/store/useNotesStore');
  const { useDictionaryStore } = require('@/store/useDictionaryStore');
  const { useSnippetsStore } = require('@/store/useSnippetsStore');
  await useAuthStore.getState().initialize();
  expect(require('../accountData').useAccountData.getState()).toMatchObject({
    owner: 'local',
    blocked: false,
    error: null,
  });
  expect(useNotesStore.getState().notes).toEqual([]);
  expect(useDictionaryStore.getState().entries).toEqual([]);
  expect(useSnippetsStore.getState().entries).toEqual([]);
  await useAuthStore.getState().signIn('account-a', 'synthetic');
  expect(useNotesStore.getState().notes).toEqual([
    expect.objectContaining({ title: 'Retained fixture', content: 'Keep this legacy note.' }),
  ]);
  expect(useDictionaryStore.getState().entries).toEqual([
    expect.objectContaining({ word: 'RetainedFixture', source: 'manual' }),
  ]);
  expect(useSnippetsStore.getState().entries).toEqual([
    { trigger: 'retained fixture', replacement: 'Keep this legacy snippet.' },
  ]);
});

it('clears shared words and invalidates pending loads across A → Local → B → A', async () => {
  require('@/db/migrate').runMigrations();
  const { prepareAccountData } = require('../accountData');
  const { notesRepository } = require('@/data');
  const {
    useSharedDictionaryStore,
    loadSharedDictionaryIfOwnedBy,
  } = require('@/store/useSharedDictionaryStore');
  const { saveSharedDictionaryState } = require('@/sync/sharedDictionaryState');
  prepareAccountData({ id: 'account-a' });
  notesRepository.setSyncState('sync.user_id', 'account-a');
  await saveSharedDictionaryState({
    workspaceId: 'workspace-a',
    workspaceName: 'Account A team',
    entries: { 'word-a': { spaceId: null, word: 'Amber' } },
    hiddenIds: [],
    scopes: [{ space_id: null }],
    paused: false,
  });
  await loadSharedDictionaryIfOwnedBy('account-a');
  expect(useSharedDictionaryStore.getState().hints.workspace).toEqual(['Amber']);
  const pendingA = useSharedDictionaryStore.getState().load();
  prepareAccountData(null);
  await pendingA;
  expect(useSharedDictionaryStore.getState().hints).toEqual({ space: [], workspace: [] });
  expect(notesRepository.getSyncState('shared_dictionary.state')).toBeNull();
  prepareAccountData({ id: 'account-b' });
  notesRepository.setSyncState('sync.user_id', 'account-b');
  await loadSharedDictionaryIfOwnedBy('account-b');
  expect(useSharedDictionaryStore.getState().summary).toBeNull();
  prepareAccountData({ id: 'account-a' });
  await loadSharedDictionaryIfOwnedBy('account-a');
  expect(useSharedDictionaryStore.getState().hints.workspace).toEqual(['Amber']);
});

it('clears shared hints even when switching the account database fails', async () => {
  require('@/db/migrate').runMigrations();
  const { prepareAccountData, useAccountData } = require('../accountData');
  const { useSharedDictionaryStore } = require('@/store/useSharedDictionaryStore');
  prepareAccountData({ id: 'account-a' });
  useSharedDictionaryStore.setState({
    hints: { space: [], workspace: ['Amber'] },
    summary: { count: 1, workspaceName: 'Account A team' },
  });
  localStorage.setItem('android.local-accounts.v1', 'invalid-json');
  expect(() => prepareAccountData({ id: 'account-b' })).toThrow();
  expect(useAccountData.getState().blocked).toBe(true);
  expect(useSharedDictionaryStore.getState().hints).toEqual({ space: [], workspace: [] });
  expect(useSharedDictionaryStore.getState().summary).toBeNull();
});

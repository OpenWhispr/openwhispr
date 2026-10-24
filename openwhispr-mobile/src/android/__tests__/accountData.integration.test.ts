import Database from 'better-sqlite3';

const mockFiles = new Map<string, InstanceType<typeof Database>>();
const mockDeleteAudio = jest.fn().mockResolvedValue(undefined);
const mockReadAudio = jest.fn().mockResolvedValue(['meeting-81.wav']);
let mockSessionUser: { id: string; email: string; isAnonymous?: boolean } | null = null;

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
  getSession: async () => mockSessionUser,
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
jest.mock('@/store/useUsageStore', () => ({
  useUsageStore: { getState: () => ({ reset: jest.fn() }) },
}));
jest.mock('@/store/useConfigStore', () => ({
  useConfigStore: {
    getState: () => ({ config: { cloudBackupEnabled: false } }),
    subscribe: () => () => {},
  },
}));
// UI projections and remote requests are outside this database/auth integration test.
jest.mock('@/store/useNotesStore', () => ({
  useNotesStore: {
    setState: jest.fn(),
    getState: () => ({
      initialize: jest.fn(),
      reset: jest.fn(),
      loadVoiceProfiles: jest.fn(),
      loadFolders: jest.fn(),
      loadSpaces: jest.fn(),
      loadNotes: jest.fn(),
    }),
  },
}));
jest.mock('@/store/useDictionaryStore', () => ({
  useDictionaryStore: { getState: () => ({ reset: jest.fn(), load: jest.fn() }) },
}));
jest.mock('@/store/useSnippetsStore', () => ({
  useSnippetsStore: { getState: () => ({ reset: jest.fn(), load: jest.fn() }) },
}));
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
  mockFiles.clear();
  mockSessionUser = { id: 'account-a', email: 'a@example.invalid' };
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
  await require('@/store/useAuthStore').useAuthStore.getState().initialize();
  const { notesRepository } = require('@/data');
  expect(() => notesRepository.getAllNotes()).toThrow('Local account data is unavailable');
  expect(require('../accountData').useAccountData.getState().error).toBeTruthy();
  expect(legacy.prepare('SELECT content FROM notes WHERE id = 81').get()).toEqual({
    content: 'Keep this private collection',
  });
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

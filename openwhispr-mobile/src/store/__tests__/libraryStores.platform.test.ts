import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from '@/db/schema';
import { useDictionaryStore as iosDictionary } from '../useDictionaryStore';
import { useDictionaryStore as androidDictionary } from '../useDictionaryStore.android';
import { useSnippetsStore as iosSnippets } from '../useSnippetsStore';
import { useSnippetsStore as androidSnippets } from '../useSnippetsStore.android';

let mockDb: ReturnType<typeof drizzle<typeof schema>>;
let raw: InstanceType<typeof Database>;
let databaseClosed: boolean;
jest.mock('@/db', () => ({
  get db() {
    return mockDb;
  },
}));
jest.mock('@/sync/syncEngine', () => ({ requestSync: jest.fn() }));
jest.mock('@/lib/uuid', () => ({ randomUUID: () => 'test-id' }));

beforeEach(() => {
  raw = new Database(':memory:');
  databaseClosed = false;
  raw.exec(`CREATE TABLE snippets (
    id INTEGER PRIMARY KEY AUTOINCREMENT, trigger TEXT NOT NULL, replacement TEXT NOT NULL,
    client_snippet_id TEXT, remote_id TEXT, deleted_at TEXT, pending_sync INTEGER NOT NULL DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now'))
  ); CREATE UNIQUE INDEX idx_snippets_trigger_lower ON snippets(lower(trigger)) WHERE deleted_at IS NULL;
  CREATE TABLE dictionary_entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,word TEXT NOT NULL,source TEXT NOT NULL DEFAULT 'manual',
    replacement TEXT,category TEXT,notes TEXT,client_dict_id TEXT,remote_id TEXT,deleted_at TEXT,
    shared_at TEXT,shared_at_cleared INTEGER NOT NULL DEFAULT 0,pending_sync INTEGER NOT NULL DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),updated_at TEXT DEFAULT (datetime('now'))
  );`);
  mockDb = drizzle(raw, { schema });
  for (const store of [iosDictionary, androidDictionary, iosSnippets, androidSnippets])
    store.getState().reset();
});
afterEach(() => {
  if (!databaseClosed) raw.close();
});

describe.each([
  { platform: 'ios', dictionary: iosDictionary, snippets: iosSnippets },
  { platform: 'android', dictionary: androidDictionary, snippets: androidSnippets },
])('$platform library boundary', ({ platform, dictionary, snippets }) => {
  for (const [kind, store] of [
    ['dictionary', dictionary],
    ['snippets', snippets],
  ] as const) {
    it(`${kind} preserves load errors in current and initial snapshots`, async () => {
      raw.close();
      databaseClosed = true;
      for (const state of [store.getState(), store.getInitialState()]) {
        let pending: Promise<void> | undefined;
        let synchronousError: unknown;
        try {
          pending = state.load();
        } catch (error) {
          synchronousError = error;
        }
        if (platform === 'ios') {
          expect(synchronousError).toBeUndefined();
          await expect(pending).rejects.toThrow();
        } else {
          expect(synchronousError).toMatchObject({
            name: 'TypeError',
            message: 'The database connection is not open',
          });
          expect(pending).toBeUndefined();
        }
      }
      expect(store.getState().isLoaded).toBe(false);
    });
  }

  it('loads both collections before the returned promises settle and preserves initial methods', async () => {
    raw.exec(
      "INSERT INTO dictionary_entries(word) VALUES ('Grafana'); INSERT INTO snippets(trigger,replacement) VALUES ('sig','Regards');",
    );
    const pending = [dictionary.getState().load(), snippets.getState().load()];
    expect(dictionary.getState().entries[0].word).toBe('Grafana');
    expect(snippets.getState().entries).toEqual([{ trigger: 'sig', replacement: 'Regards' }]);
    expect(dictionary.getInitialState().load).toBe(dictionary.getState().load);
    expect(snippets.getInitialState().load).toBe(snippets.getState().load);
    await expect(Promise.all(pending)).resolves.toEqual([undefined, undefined]);
  });

  it('preserves Unicode update and deletion behavior', () => {
    raw.exec("INSERT INTO snippets(trigger,replacement) VALUES ('Équipe','Original');");
    snippets.getState().updateSnippet('Équipe', { trigger: 'Équipe', replacement: 'Updated' });
    expect(raw.prepare('SELECT replacement FROM snippets').get()).toEqual({
      replacement: platform === 'android' ? 'Updated' : 'Original',
    });
    snippets.getState().removeSnippet('Équipe');
    expect(
      raw.prepare('SELECT count(*) AS count FROM snippets WHERE deleted_at IS NULL').get(),
    ).toEqual({ count: platform === 'android' ? 0 : 1 });
  });

  it('preserves Unicode tombstone identity behavior', () => {
    raw.exec(
      "INSERT INTO snippets(trigger,replacement,deleted_at) VALUES ('Équipe','Old','2020-01-01');",
    );
    snippets.getState().addSnippet('équipe', 'Restored');
    expect(raw.prepare('SELECT id FROM snippets WHERE deleted_at IS NULL').get()).toEqual({
      id: platform === 'android' ? 1 : 2,
    });
  });

  it('preserves editing of legacy differently cased Unicode rows', () => {
    raw.exec(
      "INSERT INTO snippets(trigger,replacement) VALUES ('Équipe','Upper'),('équipe','Lower');",
    );
    const edit = () =>
      snippets.getState().updateSnippet('Équipe', { trigger: 'Équipe', replacement: 'Updated' });
    if (platform === 'ios') expect(edit).toThrow('UNIQUE constraint failed');
    else {
      edit();
      expect(raw.prepare('SELECT replacement FROM snippets WHERE id = 1').get()).toEqual({
        replacement: 'Updated',
      });
    }
  });
});

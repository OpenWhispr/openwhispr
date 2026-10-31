import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from '@/db/schema';

let mockDb: ReturnType<typeof drizzle<typeof schema>>;
let raw: InstanceType<typeof Database>;
jest.mock('@/db', () => ({
  get db() {
    return mockDb;
  },
}));
jest.mock('@/sync/syncEngine', () => ({ requestSync: jest.fn() }));
jest.mock('@/lib/uuid', () => ({ randomUUID: () => 'test-id' }));
import { useSnippetsStore } from '../useSnippetsStore';

beforeEach(() => {
  raw = new Database(':memory:');
  raw.exec(`CREATE TABLE snippets (
    id INTEGER PRIMARY KEY AUTOINCREMENT, trigger TEXT NOT NULL, replacement TEXT NOT NULL,
    client_snippet_id TEXT, remote_id TEXT, deleted_at TEXT, pending_sync INTEGER NOT NULL DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now'))
  ); CREATE UNIQUE INDEX idx_snippets_trigger_lower ON snippets(lower(trigger)) WHERE deleted_at IS NULL;`);
  mockDb = drizzle(raw, { schema });
  useSnippetsStore.getState().reset();
});
afterEach(() => raw.close());

it('keeps legacy differently cased Unicode rows individually editable without a rename collision', () => {
  raw.prepare('INSERT INTO snippets (trigger, replacement) VALUES (?, ?)').run('Équipe', 'Upper');
  raw.prepare('INSERT INTO snippets (trigger, replacement) VALUES (?, ?)').run('équipe', 'Lower');
  const store = useSnippetsStore.getState();
  store.updateSnippet('Équipe', { trigger: 'Équipe', replacement: 'Updated upper' });
  store.updateSnippet('Équipe', { trigger: 'équipe', replacement: 'Do not overwrite' });
  expect(useSnippetsStore.getState().entries).toEqual([
    { trigger: 'Équipe', replacement: 'Updated upper' },
    { trigger: 'équipe', replacement: 'Lower' },
  ]);
  store.removeSnippet('Équipe');
  expect(useSnippetsStore.getState().entries).toEqual([
    { trigger: 'équipe', replacement: 'Lower' },
  ]);
});

it.each(['Équipe', 'ΟΜΑΔΑ', 'ÜBER'])('edits, deletes and revives Unicode trigger %s', (trigger) => {
  const store = useSnippetsStore.getState();
  store.addSnippet(trigger, 'Original');
  const id = raw.prepare('SELECT id FROM snippets').get();
  store.updateSnippet(trigger, { trigger, replacement: 'Updated' });
  expect(useSnippetsStore.getState().entries).toEqual([{ trigger, replacement: 'Updated' }]);
  store.removeSnippet(trigger);
  expect(useSnippetsStore.getState().entries).toEqual([]);
  store.addSnippet(trigger.toLowerCase(), 'Restored');
  expect(useSnippetsStore.getState().entries).toEqual([
    { trigger: trigger.toLowerCase(), replacement: 'Restored' },
  ]);
  expect(raw.prepare('SELECT id FROM snippets').get()).toEqual(id);
});

it('rejects a Unicode case-insensitive rename collision and prefers an active row over a tombstone', () => {
  const store = useSnippetsStore.getState();
  store.addSnippet('Équipe', 'First');
  store.removeSnippet('Équipe');
  raw.prepare('INSERT INTO snippets (trigger, replacement) VALUES (?, ?)').run('équipe', 'Active');
  store.addSnippet('ÉQUIPE', 'Updated active');
  store.addSnippet('Other', 'Other text');
  store.updateSnippet('Other', { trigger: 'équipe', replacement: 'Collision' });
  expect(useSnippetsStore.getState().entries).toEqual([
    { trigger: 'ÉQUIPE', replacement: 'Updated active' },
    { trigger: 'Other', replacement: 'Other text' },
  ]);
  expect(
    raw.prepare('SELECT count(*) AS n FROM snippets WHERE deleted_at IS NOT NULL').get(),
  ).toEqual({ n: 1 });
});

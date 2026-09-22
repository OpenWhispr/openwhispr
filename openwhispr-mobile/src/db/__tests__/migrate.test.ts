import Database from 'better-sqlite3';

type RawDb = InstanceType<typeof Database>;

// migrate.ts only ever calls execSync/runSync/getAllSync on its `rawDb` handle —
// wrap a real (in-memory) better-sqlite3 database behind that same surface so
// the mocked 'expo-sqlite' module below lets us exercise the REAL runMigrations()
// against a real SQL engine, instead of re-deriving its statements in the test.
function makeFakeExpoDb(raw: RawDb) {
  return {
    execSync: (sql: string): void => {
      raw.exec(sql);
    },
    runSync: (sql: string, ...params: unknown[]) => {
      const info = raw.prepare(sql).run(...params);
      return { changes: info.changes, lastInsertRowId: Number(info.lastInsertRowid) };
    },
    getAllSync: <T>(sql: string, ...params: unknown[]): T[] =>
      raw.prepare(sql).all(...params) as T[],
  };
}

function createFakeLocalStorage(): Storage {
  const store = new Map<string, string>();
  return {
    getItem: (key: string): string | null => store.get(key) ?? null,
    setItem: (key: string, value: string): void => {
      store.set(key, value);
    },
    removeItem: (key: string): void => {
      store.delete(key);
    },
    clear: (): void => {
      store.clear();
    },
    key: (index: number): string | null => Array.from(store.keys())[index] ?? null,
    get length(): number {
      return store.size;
    },
  };
}

describe('runMigrations — spaces', () => {
  let raw: RawDb;

  beforeEach(() => {
    jest.resetModules();
    raw = new Database(':memory:');
    globalThis.localStorage = createFakeLocalStorage();

    jest.doMock('expo-sqlite', () => ({
      openDatabaseSync: () => makeFakeExpoDb(raw),
    }));
    jest.doMock('expo-sqlite/localStorage/install', () => ({}));
  });

  afterEach(() => {
    raw.close();
    Reflect.deleteProperty(globalThis, 'localStorage');
    jest.dontMock('expo-sqlite');
    jest.dontMock('expo-sqlite/localStorage/install');
  });

  function loadMigrate(): typeof import('@/db/migrate') {
    return require('@/db/migrate') as typeof import('@/db/migrate');
  }

  // Mirrors migrate.ts's very first (pre-spaces) CREATE TABLE shape for
  // notes/folders — i.e. before any addColumnIfMissing columns exist — so the
  // "upgrade path" tests below simulate a genuinely pre-existing install
  // rather than an unrealistically bare table.
  function createLegacyNotesAndFolders(): void {
    raw.exec(`
      CREATE TABLE notes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL DEFAULT 'Untitled',
        content TEXT NOT NULL DEFAULT '',
        folder_id INTEGER REFERENCES folders(id) ON DELETE SET NULL,
        note_type TEXT DEFAULT 'personal',
        source_file TEXT,
        audio_duration_seconds REAL,
        enhanced_content TEXT,
        enhancement_prompt TEXT,
        enhanced_at_content_hash TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      );

      CREATE TABLE folders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        is_default INTEGER DEFAULT 0,
        sort_order INTEGER DEFAULT 0,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      );
    `);
  }

  function privateSpaces(): Array<{
    id: number;
    client_space_id: string;
    name: string;
    kind: string;
    sort_order: number;
    sync_status: string;
  }> {
    return raw.prepare("SELECT * FROM spaces WHERE kind = 'private'").all() as never[];
  }

  it('fresh install: creates the spaces table and seeds exactly one private space', () => {
    const { runMigrations } = loadMigrate();
    runMigrations();

    const rows = privateSpaces();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      name: 'Personal',
      kind: 'private',
      sort_order: 0,
      sync_status: 'synced',
    });
    expect(rows[0].client_space_id).toEqual(expect.any(String));
    expect(rows[0].client_space_id.length).toBeGreaterThan(0);
  });

  it('fresh install: default seeded folders/notes are backfilled into the private space', () => {
    const { runMigrations } = loadMigrate();
    runMigrations();

    const privateSpaceId = privateSpaces()[0].id;
    const folderSpaceIds = (
      raw.prepare('SELECT space_id FROM folders').all() as Array<{ space_id: number }>
    ).map((r) => r.space_id);
    // The migration seeds two default folders (Personal, Meetings); both must
    // resolve into the same private space.
    expect(folderSpaceIds.length).toBeGreaterThan(0);
    expect(folderSpaceIds.every((id) => id === privateSpaceId)).toBe(true);
  });

  it('upgrade path: notes/folders that predate this migration get backfilled to the private space', () => {
    // Simulate a device that installed before spaces existed: the pre-spaces
    // notes/folders shape, already populated with real data.
    createLegacyNotesAndFolders();
    raw.exec(`
      INSERT INTO folders (id, name, is_default, sort_order) VALUES (1, 'Personal', 1, 0);
      INSERT INTO notes (id, title, content, folder_id) VALUES (100, 'Pre-existing note', 'hello', 1);
    `);

    const { runMigrations } = loadMigrate();
    runMigrations();

    const privateSpaceId = privateSpaces()[0].id;
    const note = raw.prepare('SELECT space_id FROM notes WHERE id = 100').get() as {
      space_id: number;
    };
    const folder = raw.prepare('SELECT space_id FROM folders WHERE id = 1').get() as {
      space_id: number;
    };
    expect(note.space_id).toBe(privateSpaceId);
    expect(folder.space_id).toBe(privateSpaceId);
  });

  it('new note columns (owner/updated-by/cloud_updated_at/left_team) exist and default sanely after an upgrade', () => {
    createLegacyNotesAndFolders();
    raw.exec("INSERT INTO notes (id, title, content) VALUES (100, 'Pre-existing note', 'hello');");

    const { runMigrations } = loadMigrate();
    runMigrations();

    const note = raw.prepare('SELECT * FROM notes WHERE id = 100').get() as Record<string, unknown>;
    expect(note.owner_user_id).toBeNull();
    expect(note.updated_by_user_id).toBeNull();
    expect(note.cloud_updated_at).toBeNull();
    expect(note.conflict_server_note).toBeNull();
    expect(note.left_team).toBe(0);
  });

  it('conflict_server_note is additive: existing rows keep their data and the column is writable', () => {
    createLegacyNotesAndFolders();
    raw.exec("INSERT INTO notes (id, title, content) VALUES (100, 'Pre-existing note', 'hello');");

    const { runMigrations } = loadMigrate();
    runMigrations();
    raw
      .prepare('UPDATE notes SET conflict_server_note = ? WHERE id = 100')
      .run('{"id":"srv-1","updated_at":"2026-08-24T00:00:00.000Z"}');

    const note = raw
      .prepare('SELECT title, conflict_server_note FROM notes WHERE id = 100')
      .get() as {
      title: string;
      conflict_server_note: string;
    };
    expect(note.title).toBe('Pre-existing note');
    expect(note.conflict_server_note).toBe(
      '{"id":"srv-1","updated_at":"2026-08-24T00:00:00.000Z"}',
    );
  });

  it('running the migration twice is a no-op: no duplicate private space, id and client_space_id stable', () => {
    const { runMigrations } = loadMigrate();
    runMigrations();
    const first = privateSpaces();

    runMigrations();
    const second = privateSpaces();

    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
    expect(second[0].id).toBe(first[0].id);
    expect(second[0].client_space_id).toBe(first[0].client_space_id);
  });

  it('running the migration twice re-backfills any row a caller nulled out in between', () => {
    const { runMigrations } = loadMigrate();
    runMigrations();

    raw.prepare("INSERT INTO notes (title, content) VALUES ('New note', 'x')").run();
    raw.prepare("UPDATE notes SET space_id = NULL WHERE title = 'New note'").run();

    runMigrations();

    const privateSpaceId = privateSpaces()[0].id;
    const row = raw.prepare("SELECT space_id FROM notes WHERE title = 'New note'").get() as {
      space_id: number;
    };
    expect(row.space_id).toBe(privateSpaceId);
  });

  it('creates unique indexes on client_space_id and (partial) cloud_space_id', () => {
    const { runMigrations } = loadMigrate();
    runMigrations();
    runMigrations();

    const privateSpaceId = privateSpaces()[0].id;
    const clientSpaceId = raw
      .prepare('SELECT client_space_id FROM spaces WHERE id = ?')
      .get(privateSpaceId) as { client_space_id: string };

    // A second insert reusing the same client_space_id must be rejected —
    // proves the unique index survived a second migration run intact.
    expect(() =>
      raw
        .prepare("INSERT INTO spaces (client_space_id, kind, name) VALUES (?, 'team', 'Dup')")
        .run(clientSpaceId.client_space_id),
    ).toThrow(/UNIQUE constraint failed/);

    // Two spaces both carrying a NULL cloud_space_id must be allowed (the
    // partial index only guards non-NULL values).
    expect(() =>
      raw.exec(
        "INSERT INTO spaces (client_space_id, kind, name) VALUES ('other-1', 'team', 'A'); " +
          "INSERT INTO spaces (client_space_id, kind, name) VALUES ('other-2', 'team', 'B');",
      ),
    ).not.toThrow();
  });
});

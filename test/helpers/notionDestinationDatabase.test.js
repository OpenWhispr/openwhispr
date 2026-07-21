const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");

let userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-notion-db-"));
const originalLoad = Module._load;

Module._load = function patchedLoad(request, parent, isMain) {
  if (request === "electron") {
    return {
      app: {
        getPath: () => userDataDir,
        getAppPath: () => process.cwd(),
        isReady: () => false,
      },
      safeStorage: {
        isEncryptionAvailable: () => false,
      },
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};

process.env.NODE_ENV = "test";

const DatabaseManager = require("../../src/helpers/database.js");

function isNativeBindingUnavailable(error) {
  const message = String(error?.message || error);
  return (
    message.includes("NODE_MODULE_VERSION") || message.includes("Could not locate the bindings file")
  );
}

function createLegacyDatabase(t) {
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-notion-db-"));
  let BetterSqlite;
  try {
    BetterSqlite = require("better-sqlite3");
  } catch (error) {
    if (isNativeBindingUnavailable(error)) {
      t.skip("better-sqlite3 native binding is not available for this Node runtime");
      return null;
    }
    throw error;
  }

  let legacy;
  try {
    legacy = new BetterSqlite(path.join(userDataDir, "transcriptions.db"));
  } catch (error) {
    if (isNativeBindingUnavailable(error)) {
      t.skip("better-sqlite3 native binding is not available for this Node runtime");
      return null;
    }
    throw error;
  }
  try {
    legacy.exec(`
    CREATE TABLE notion_connections (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      bot_id TEXT NOT NULL UNIQUE,
      workspace_id TEXT NOT NULL,
      workspace_name TEXT,
      workspace_icon TEXT,
      encrypted_access_token BLOB NOT NULL,
      encrypted_refresh_token BLOB,
      access_token_expires_at INTEGER,
      connected_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE notion_destinations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      connection_id INTEGER NOT NULL REFERENCES notion_connections(id),
      data_source_id TEXT NOT NULL,
      database_id TEXT,
      data_source_name TEXT NOT NULL,
      schema_snapshot TEXT NOT NULL,
      layout_key TEXT NOT NULL DEFAULT 'general',
      include_transcript INTEGER NOT NULL DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(connection_id)
    );
    CREATE TABLE notes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL DEFAULT 'Untitled Note',
      content TEXT NOT NULL DEFAULT '',
      note_type TEXT NOT NULL DEFAULT 'personal',
      source_file TEXT,
      audio_duration_seconds REAL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE notion_publications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      note_id INTEGER NOT NULL REFERENCES notes(id),
      client_note_id TEXT,
      destination_id INTEGER NOT NULL REFERENCES notion_destinations(id),
      content_hash TEXT NOT NULL,
      notion_page_id TEXT,
      notion_page_url TEXT,
      next_block_index INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'pending',
      attempt_count INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    INSERT INTO notion_connections (
      id, bot_id, workspace_id, encrypted_access_token
    ) VALUES (4, 'bot', 'workspace', X'01');
    INSERT INTO notion_destinations (
      id, connection_id, data_source_id, data_source_name, schema_snapshot
    ) VALUES (7, 4, 'source-a', 'Source A', '{}');
    INSERT INTO notes (id, title, content, note_type) VALUES (99, 'Legacy', '', 'personal');
    INSERT INTO notion_publications (
      id, note_id, destination_id, content_hash, status
    ) VALUES (9, 99, 7, 'old-hash', 'published');
    `);
  } catch (error) {
    throw new Error(`Legacy Notion database setup failed: ${error.message}`, { cause: error });
  }
  legacy.close();

  try {
    return new DatabaseManager();
  } catch (error) {
    if (isNativeBindingUnavailable(error)) {
      t.skip("better-sqlite3 native binding is not available for this Node runtime");
      return null;
    }
    throw new Error(`Notion database migration failed: ${error.message}`, { cause: error });
  }
}

test("migrates destinations to immutable per-data-source identities", (t) => {
  const database = createLegacyDatabase(t);
  if (!database) return;

  const sourceA = database.getNotionDestination(4);
  assert.equal(sourceA.id, 7);
  assert.equal(
    database.db.prepare("SELECT destination_id FROM notion_publications WHERE id = 9").get()
      .destination_id,
    7
  );
  database.db.prepare("UPDATE notion_publications SET status = 'publishing' WHERE id = 9").run();
  assert.equal(database.findUncertainNotionPublication(99, 7, "old-hash").id, 9);
  assert.equal(database.findResumableNotionPublication(99, 7, "old-hash"), null);

  const sourceB = database.saveNotionDestination({
    connectionId: 4,
    dataSourceId: "source-b",
    dataSourceName: "Source B",
    schemaSnapshot: {},
    layoutKey: "general",
    includeTranscript: false,
  });
  assert.notEqual(sourceB.id, sourceA.id);
  assert.equal(sourceB.is_selected, 1);
  assert.equal(database.getNotionDestination(4).data_source_id, "source-b");

  const selectedAgain = database.saveNotionDestination({
    connectionId: 4,
    dataSourceId: "source-a",
    dataSourceName: "Source A refreshed",
    schemaSnapshot: { properties: {} },
    layoutKey: "meeting",
    includeTranscript: true,
  });
  assert.equal(selectedAgain.id, sourceA.id);
  assert.equal(selectedAgain.is_selected, 1);
  assert.equal(database.getNotionDestination(4).data_source_id, "source-a");
  assert.equal(database.db.prepare("SELECT COUNT(*) AS count FROM notion_destinations").get().count, 2);
  assert.equal(
    database.db
      .prepare("SELECT COUNT(*) AS count FROM notion_destinations WHERE is_selected = 1")
      .get().count,
    1
  );
  assert.deepEqual(database.db.pragma("foreign_key_check"), []);

  database.db.close();
});

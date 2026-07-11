const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");

let userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-cleanup-level-db-"));
const originalLoad = Module._load;

Module._load = function patchedLoad(request, parent, isMain) {
  if (request === "electron") {
    return { app: { getPath: () => userDataDir, getAppPath: () => process.cwd(), isReady: () => false } };
  }
  return originalLoad.call(this, request, parent, isMain);
};

process.env.NODE_ENV = "test";
const DatabaseManager = require("../../src/helpers/database.js");

function createDb(t) {
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-cleanup-level-db-"));
  const db = new DatabaseManager();
  t.after(() => {
    db.db.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  });
  return db;
}

test("stores a validated cleanup level with a completed transcript", (t) => {
  const db = createDb(t);
  const saved = db.saveTranscription("Cleaned.", "um cleaned", { cleanupLevel: "high" });

  assert.equal(saved.transcription.cleanup_level, "high");
  assert.equal(db.getTranscriptionById(saved.id).cleanup_level, "high");
});

test("invalid and disabled cleanup levels are stored as no level", (t) => {
  const db = createDb(t);

  assert.equal(
    db.saveTranscription("Raw", "Raw", { cleanupLevel: "none" }).transcription.cleanup_level,
    null
  );
  assert.equal(
    db.saveTranscription("Raw", "Raw", { cleanupLevel: "aggressive" }).transcription.cleanup_level,
    null
  );
});

test("reprocessing updates the historical level without changing the raw source", (t) => {
  const db = createDb(t);
  const { id } = db.saveTranscription("First", "exact raw", { cleanupLevel: "light" });

  db.updateTranscriptionText(id, "Second", "exact raw", "high");
  const updated = db.getTranscriptionById(id);
  assert.equal(updated.cleanup_level, "high");
  assert.equal(updated.raw_text, "exact raw");
});

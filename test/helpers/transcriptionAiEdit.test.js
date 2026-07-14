const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");

let userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-ai-edit-db-"));
const originalLoad = Module._load;

Module._load = function patchedLoad(request, parent, isMain) {
  if (request === "electron") {
    return {
      app: {
        getPath: () => userDataDir,
        getAppPath: () => process.cwd(),
        isReady: () => false,
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
    message.includes("NODE_MODULE_VERSION") ||
    message.includes("Could not locate the bindings file")
  );
}

function createDb(t) {
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-ai-edit-db-"));
  let db;
  try {
    db = new DatabaseManager();
  } catch (error) {
    if (isNativeBindingUnavailable(error)) {
      t.skip("better-sqlite3 native binding is not available for this Node runtime");
      return null;
    }
    throw error;
  }
  t.after(() => {
    db.db.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  });
  return db;
}

test("undo and redo switch the active version without swapping stored text", (t) => {
  const db = createDb(t);
  if (!db) return;
  const { id, transcription } = db.saveTranscription("Cleaned text.", "um cleaned text");
  assert.equal(transcription.ai_edit_applied, 1);

  const undone = db.setTranscriptionAiEditApplied(id, false);
  assert.equal(undone.success, true);
  assert.equal(undone.transcription.ai_edit_applied, 0);
  assert.equal(undone.transcription.text, "Cleaned text.");
  assert.equal(undone.transcription.raw_text, "um cleaned text");

  const redone = db.setTranscriptionAiEditApplied(id, true);
  assert.equal(redone.success, true);
  assert.equal(redone.transcription.ai_edit_applied, 1);
  assert.equal(redone.transcription.text, "Cleaned text.");
  assert.equal(redone.transcription.raw_text, "um cleaned text");
});

test("rows without raw text cannot enter the reversible AI edit state", (t) => {
  const db = createDb(t);
  if (!db) return;
  const { id } = db.saveTranscription("Only version", null);

  assert.deepEqual(db.setTranscriptionAiEditApplied(id, false), {
    success: false,
    transcription: null,
  });
  assert.equal(db.getTranscriptionById(id).ai_edit_applied, 1);
});

test("a new cleanup result automatically becomes the active version", (t) => {
  const db = createDb(t);
  if (!db) return;
  const { id } = db.saveTranscription("First cleanup", "raw words");
  db.setTranscriptionAiEditApplied(id, false);

  db.updateTranscriptionText(id, "Second cleanup", "new raw words");
  const updated = db.getTranscriptionById(id);
  assert.equal(updated.ai_edit_applied, 1);
  assert.equal(updated.text, "Second cleanup");
  assert.equal(updated.raw_text, "new raw words");
});

test("cloud refreshes preserve the device-local active version", (t) => {
  const db = createDb(t);
  if (!db) return;
  const { id } = db.saveTranscription("Local cleanup", "local raw", {
    clientTranscriptionId: "sync-ai-edit",
  });
  db.setTranscriptionAiEditApplied(id, false);

  const updated = db.upsertTranscriptionFromCloud({
    id: "cloud-ai-edit",
    client_transcription_id: "sync-ai-edit",
    text: "Cloud cleanup",
    raw_text: "cloud raw",
    status: "completed",
    created_at: "2026-07-11T16:00:00.000Z",
  });

  assert.equal(updated.ai_edit_applied, 0);
  assert.equal(updated.text, "Cloud cleanup");
  assert.equal(updated.raw_text, "cloud raw");
});

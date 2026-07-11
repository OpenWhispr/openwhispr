const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");

let userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-translation-db-"));
const originalLoad = Module._load;

Module._load = function patchedLoad(request, parent, isMain) {
  if (request === "electron") {
    return {
      app: { getPath: () => userDataDir, getAppPath: () => process.cwd(), isReady: () => false },
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};

process.env.NODE_ENV = "test";
const DatabaseManager = require("../../src/helpers/database.js");

function createDb(t) {
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-translation-db-"));
  const db = new DatabaseManager();
  t.after(() => {
    db.db.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  });
  return db;
}

test("stores a validated translation target with both transcript versions", (t) => {
  const db = createDb(t);
  const saved = db.saveTranscription("Bonjour.", "Hello.", { translationTarget: "fr" });

  assert.equal(saved.transcription.translation_target, "fr");
  assert.equal(saved.transcription.text, "Bonjour.");
  assert.equal(saved.transcription.raw_text, "Hello.");
});

test("rejects auto-detect and unknown translation targets", (t) => {
  const db = createDb(t);

  assert.equal(
    db.saveTranscription("Text", "Text", { translationTarget: "auto" }).transcription
      .translation_target,
    null
  );
  assert.equal(
    db.saveTranscription("Text", "Text", { translationTarget: "unknown" }).transcription
      .translation_target,
    null
  );
});

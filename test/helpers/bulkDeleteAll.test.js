const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { installElectronStub } = require("./harness/electronStub.js");

installElectronStub();
const WhisperManager = require("../../src/helpers/whisper.js");
const ParakeetManager = require("../../src/helpers/parakeet.js");
const AudioStorageManager = require("../../src/helpers/audioStorage.js");

test("bulk model deletion reports a surviving Whisper or Parakeet model", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-model-delete-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const whisperDir = path.join(dir, "whisper");
  fs.mkdirSync(whisperDir);
  const whisperFile = path.join(whisperDir, "blocked.bin");
  fs.writeFileSync(whisperFile, "model");
  const whisper = Object.create(WhisperManager.prototype);
  whisper.getModelsDir = () => whisperDir;
  const unlink = fs.promises.unlink;
  fs.promises.unlink = async (file) => {
    if (file === whisperFile) throw new Error("access denied");
    return unlink(file);
  };
  try {
    const result = await whisper.deleteAllWhisperModels();
    assert.equal(result.success, false);
    assert.equal(result.deleted_count, 0);
  } finally {
    fs.promises.unlink = unlink;
  }

  const parakeetDir = path.join(dir, "parakeet");
  const modelDir = path.join(parakeetDir, "blocked");
  fs.mkdirSync(modelDir, { recursive: true });
  const parakeet = Object.create(ParakeetManager.prototype);
  parakeet.getModelsDir = () => parakeetDir;
  parakeet._getModelWeightsSize = () => 5;
  const rm = fs.rmSync;
  fs.rmSync = (file, options) => {
    if (file === modelDir) throw new Error("access denied");
    return rm(file, options);
  };
  try {
    const result = await parakeet.deleteAllParakeetModels();
    assert.equal(result.success, false);
    assert.equal(result.deleted_count, 0);
    assert.equal(result.freed_bytes, 0);
  } finally {
    fs.rmSync = rm;
  }
  assert.equal(fs.existsSync(modelDir), true);
});

test("deleting a model that is already gone succeeds so the list can refresh", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-model-absent-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const [Manager, method] of [
    [WhisperManager, "deleteWhisperModel"],
    [ParakeetManager, "deleteParakeetModel"],
  ]) {
    const manager = Object.create(Manager.prototype);
    manager.getModelPath = (name) => path.join(dir, name);
    const result = await manager[method]("missing");
    assert.equal(result.success, true, method);
    assert.equal(result.deleted, false, method);
    assert.equal(result.freed_mb, 0, method);
  }
});

// Folded from audioStorageDeleteAll.test.js — same installElectronStub fixture
// and the same "bulk deleteAll reports partial failures" mechanism.
test("bulk audio deletion reports partial failures and the IDs it could not delete", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-audio-delete-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const manager = Object.create(AudioStorageManager.prototype);
  manager.audioDir = dir;
  const good = path.join(dir, "OpenWhispr-10.webm");
  const blocked = path.join(dir, "OpenWhispr-11.webm");
  const legacy = path.join(dir, "11.webm");
  fs.writeFileSync(good, "ok");
  fs.writeFileSync(legacy, "old copy");
  fs.writeFileSync(blocked, "keep");
  const unlink = fs.unlinkSync;
  fs.unlinkSync = (file) => {
    if (file === blocked) throw new Error("access denied");
    return unlink(file);
  };
  let result;
  try {
    result = manager.deleteAllAudio();
  } finally {
    fs.unlinkSync = unlink;
  }
  assert.deepEqual(result, { deleted: 2, failedIds: ["11"], failed: true });
  assert.equal(
    fs.existsSync(legacy),
    false,
    "one deleted file cannot clear an ID with another remaining file"
  );
  assert.equal(fs.existsSync(good), false);
  assert.equal(fs.existsSync(blocked), true);
});

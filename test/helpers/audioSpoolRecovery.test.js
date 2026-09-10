const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === "electron") return { app: { isPackaged: false, getPath: () => os.tmpdir() } };
  return originalLoad.call(this, request, parent, isMain);
};
const AudioStorageManager = require("../../src/helpers/audioStorage");
Module._load = originalLoad;

function createMockDatabaseManager() {
  let nextId = 1;
  const transcriptions = new Map();

  return {
    transcriptions,
    saveTranscription(text, rawText, options = {}) {
      const id = nextId++;
      const row = {
        id,
        text,
        raw_text: rawText,
        status: options.status || "completed",
        error_message: options.errorMessage || null,
        error_code: options.errorCode || null,
        client_transcription_id: options.clientTranscriptionId || null,
        has_audio: 0,
        audio_duration_ms: null,
        timestamp: new Date().toISOString(),
      };
      transcriptions.set(id, row);
      return { id, success: true, transcription: row };
    },
    updateTranscriptionAudio(id, { hasAudio, audioDurationMs, provider, model }) {
      const row = transcriptions.get(id);
      if (row) {
        row.has_audio = hasAudio;
        row.audio_duration_ms = audioDurationMs;
        row.provider = provider;
        row.model = model;
      }
      return { success: true };
    },
    getTranscriptionById(id) {
      return transcriptions.get(id) || null;
    },
  };
}

test("AudioStorageManager: spool lifecycle (start, append, finish)", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-spool-test-"));
  try {
    const manager = new AudioStorageManager({ audioDir: tempDir });
    const sessionId = "test-session-123";

    // 1. Start spooling
    const startResult = manager.startRecordingSpool(sessionId, "audio/webm");
    assert.equal(startResult.success, true);

    const manifestPath = path.join(tempDir, "spool", `${sessionId}.json`);
    const audioPath = path.join(tempDir, "spool", `${sessionId}.webm`);

    assert.ok(fs.existsSync(manifestPath), "Manifest file should exist");
    assert.ok(fs.existsSync(audioPath), "Audio spool file should exist");

    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    assert.equal(manifest.sessionId, sessionId);
    assert.equal(manifest.mimeType, "audio/webm");

    // 2. Append chunks
    const chunk1 = Buffer.from("chunk-part-1-");
    const chunk2 = Buffer.from("chunk-part-2");
    manager.appendRecordingSpoolChunk(sessionId, chunk1);
    manager.appendRecordingSpoolChunk(sessionId, chunk2);

    const spooledBytes = fs.readFileSync(audioPath);
    assert.equal(spooledBytes.toString(), "chunk-part-1-chunk-part-2");

    // 3. Finish spooling cleans up
    const finishResult = manager.finishRecordingSpool(sessionId);
    assert.equal(finishResult.success, true);
    assert.ok(!fs.existsSync(manifestPath), "Manifest should be removed after finish");
    assert.ok(!fs.existsSync(audioPath), "Audio spool file should be removed after finish");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("AudioStorageManager: recoverOrphanedRecordings recovers valid abandoned sessions", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-spool-recovery-"));
  try {
    const manager = new AudioStorageManager({ audioDir: tempDir });
    const db = createMockDatabaseManager();
    const sessionId = "abandoned-session-456";

    // Simulate an abandoned recording session (>1KB audio)
    manager.startRecordingSpool(sessionId, "audio/webm");
    const audioData = Buffer.alloc(2048, "a"); // 2KB of audio
    manager.appendRecordingSpoolChunk(sessionId, audioData);

    // Call recovery as would happen on startup
    const recovered = manager.recoverOrphanedRecordings(db);

    assert.equal(recovered.length, 1);
    assert.equal(recovered[0].status, "failed");
    assert.equal(recovered[0].error_code, "CRASH_RECOVERY");
    assert.match(recovered[0].error_message, /unexpected app shutdown/i);
    assert.equal(recovered[0].client_transcription_id, sessionId);
    assert.equal(recovered[0].has_audio, 1);

    // Verify audio was moved to permanent storage
    const storedAudio = manager.getAudioBuffer(recovered[0].id);
    assert.ok(storedAudio, "Audio should be saved in permanent audio storage");
    assert.equal(storedAudio.length, 2048);

    // Verify spool files were cleaned up
    const spoolManifest = path.join(tempDir, "spool", `${sessionId}.json`);
    const spoolAudio = path.join(tempDir, "spool", `${sessionId}.webm`);
    assert.ok(!fs.existsSync(spoolManifest), "Spool manifest should be deleted after recovery");
    assert.ok(!fs.existsSync(spoolAudio), "Spool audio file should be deleted after recovery");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("AudioStorageManager: recoverOrphanedRecordings ignores degenerate (<1KB) sessions", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-spool-degenerate-"));
  try {
    const manager = new AudioStorageManager({ audioDir: tempDir });
    const db = createMockDatabaseManager();
    const sessionId = "tiny-session-789";

    // Simulate an abandoned recording with negligible size (<1KB)
    manager.startRecordingSpool(sessionId, "audio/webm");
    const audioData = Buffer.alloc(100, "x");
    manager.appendRecordingSpoolChunk(sessionId, audioData);

    const recovered = manager.recoverOrphanedRecordings(db);

    assert.equal(recovered.length, 0, "Should not recover degenerate recording");
    assert.equal(db.transcriptions.size, 0, "Should not insert row into database");

    // Verify spool files were cleaned up
    const spoolManifest = path.join(tempDir, "spool", `${sessionId}.json`);
    const spoolAudio = path.join(tempDir, "spool", `${sessionId}.webm`);
    assert.ok(!fs.existsSync(spoolManifest), "Spool manifest should be removed");
    assert.ok(!fs.existsSync(spoolAudio), "Spool audio file should be removed");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("AudioStorageManager: recoverOrphanedRecordings handles corrupt manifests and orphaned .webm files", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-spool-corrupt-"));
  try {
    const manager = new AudioStorageManager({ audioDir: tempDir });
    const db = createMockDatabaseManager();

    // 1. Corrupt manifest
    const corruptManifestPath = path.join(tempDir, "spool", "corrupt.json");
    fs.writeFileSync(corruptManifestPath, "not valid json {{{");

    // 2. Orphaned webm file without a manifest
    const orphanedWebmPath = path.join(tempDir, "spool", "dangling.webm");
    fs.writeFileSync(orphanedWebmPath, Buffer.alloc(500));

    const recovered = manager.recoverOrphanedRecordings(db);

    assert.equal(recovered.length, 0);
    assert.ok(!fs.existsSync(corruptManifestPath), "Corrupt manifest should be removed");
    assert.ok(!fs.existsSync(orphanedWebmPath), "Dangling webm should be removed");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

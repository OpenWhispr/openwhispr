const test = require("node:test");
const assert = require("node:assert/strict");

const LocalModelDownloadStatus = require("../../src/helpers/localModelDownloadStatus");

test("tracks independent local model downloads with normalized progress", () => {
  const status = new LocalModelDownloadStatus();

  const whisper = status.start("whisper", "base");
  const llm = status.start("llm", "qwen-2.5-7b");
  const installing = status.update("parakeet", "parakeet-tdt-0.6b-v3", {
    phase: "installing",
    progress: 100,
  });
  const progressed = status.update("whisper", "base", {
    progress: 42,
    downloadedBytes: 42,
    totalBytes: 100,
  });

  assert.equal(whisper.phase, "downloading");
  assert.equal(llm.progress, 0);
  assert.equal(installing.phase, "installing");
  assert.equal(progressed.sequence > installing.sequence, true);
  assert.deepEqual(status.getActiveDownloads(), [progressed, llm, installing]);
});

test("does not reset an existing download and removes it only on finish", () => {
  const status = new LocalModelDownloadStatus();

  status.start("llm", "qwen-2.5-7b");
  const progressed = status.update("llm", "qwen-2.5-7b", {
    progress: 55,
    downloadedBytes: 55,
    totalBytes: 100,
  });
  const duplicateStart = status.start("llm", "qwen-2.5-7b");

  assert.deepEqual(duplicateStart, progressed);
  assert.equal(status.has("llm", "qwen-2.5-7b"), true);

  const finished = status.finish("llm", "qwen-2.5-7b");
  assert.equal(finished.progress, 55);
  assert.equal(finished.sequence > progressed.sequence, true);
  assert.deepEqual(status.getActiveDownloads(), []);
});

test("starts an active download with zero progress", () => {
  const status = new LocalModelDownloadStatus();
  const started = status.start("whisper", "small");

  assert.equal(started.modelType, "whisper");
  assert.equal(started.phase, "downloading");
  assert.equal(started.progress, 0);
  assert.equal(started.downloadedBytes, 0);
  assert.equal(started.totalBytes, 0);
});

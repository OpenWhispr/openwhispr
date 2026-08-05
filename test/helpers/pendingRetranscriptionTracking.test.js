const test = require("node:test");
const assert = require("node:assert/strict");

const IPCHandlers = require("../../src/helpers/ipcHandlers");

// The pending set is what _drainPendingRetranscriptions re-runs once the large model
// finishes downloading. It used to be cleared on pipeline:complete — in the same run that
// added the note — so it was always empty and the retry never happened.
function createObserver() {
  const handlers = Object.create(IPCHandlers.prototype);
  handlers._pendingRetranscriptionNoteIds = new Set();
  return handlers;
}

async function runPipeline({ modelDownloaded }) {
  const { PostCallPipelineManager } = await import("../../src/helpers/postCallPipelineManager.js");
  const handlers = createObserver();

  const note = {
    id: 5,
    transcript: JSON.stringify([
      { text: "hello", speaker: "speaker_0", source: "system", timestamp: 0 },
    ]),
    system_audio_path: "/tmp/pending-test.opus",
    mic_audio_path: null,
    meeting_type_id: null,
  };

  const fs = require("fs");
  const origExists = fs.existsSync;
  const origReadFile = fs.readFileSync;
  const origUnlink = fs.unlinkSync;
  fs.existsSync = (p) => {
    if (p === "/tmp/pending-test.opus") return true;
    if (p === "/tmp/model.bin") return modelDownloaded;
    return origExists(p);
  };
  fs.readFileSync = (...args) =>
    typeof args[0] === "string" && args[0].includes("ow-retranscribe")
      ? Buffer.from("fake wav")
      : origReadFile(...args);
  fs.unlinkSync = (p) => {
    if (!String(p).includes("ow-retranscribe")) origUnlink(p);
  };

  try {
    const manager = new PostCallPipelineManager({
      broadcast: (channel, data) => handlers._observePipelineStatus(channel, data),
      databaseManager: {
        getNote: () => note,
        updateNote: () => ({ success: true }),
        getMeetingTypes: () => [],
        getMeetingType: () => null,
        getNoteSpeakerEmbeddings: () => [],
        pruneNoteSpeakerEmbeddings: () => {},
        getSpeakerMappings: () => [],
      },
      whisperManager: {
        getModelPath: () => "/tmp/model.bin",
        transcribeLocalWhisper: async () => ({
          success: true,
          text: "fresh words",
          segments: [{ start: 0, end: 2, text: "fresh words" }],
        }),
      },
      diarizationManager: { isAvailable: () => false },
      inference: { processText: async () => "result" },
      convertToWav: async () => {},
    });

    await manager.run(note.id);
    return handlers._pendingRetranscriptionNoteIds;
  } finally {
    fs.existsSync = origExists;
    fs.readFileSync = origReadFile;
    fs.unlinkSync = origUnlink;
  }
}

test("a note still waiting for the large model stays pending after the run completes", async () => {
  const pending = await runPipeline({ modelDownloaded: false });

  assert.deepEqual([...pending], [5], "the drain queue has nothing to retry if this is empty");
});

test("a note whose re-transcription succeeded is not left pending", async () => {
  const pending = await runPipeline({ modelDownloaded: true });

  assert.deepEqual([...pending], []);
});

test("running sub-stages neither add nor clear a pending note", () => {
  const handlers = createObserver();

  handlers._observePipelineStatus("post-call-pipeline-status", {
    noteId: 1,
    step: "retranscribe",
    status: "pending",
  });
  handlers._observePipelineStatus("post-call-pipeline-status", {
    noteId: 1,
    step: "retranscribe",
    status: "running",
    subStage: "transcribing",
  });
  handlers._observePipelineStatus("post-call-pipeline-status", {
    noteId: 1,
    step: "pipeline",
    status: "complete",
  });

  assert.deepEqual([...handlers._pendingRetranscriptionNoteIds], [1]);
});

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

// The manual "re-transcribe" IPC handler used to carry its own copy of the pipeline's
// transcript-writing logic, and therefore its own copy of the flattening bug. It must
// delegate to the shared module rather than reimplementing it.
const HANDLER_SOURCE = (() => {
  const source = fs.readFileSync(
    path.join(__dirname, "../../src/helpers/ipcHandlers.js"),
    "utf8"
  );
  const start = source.indexOf('ipcMain.handle("retranscribe-meeting-note"');
  const end = source.indexOf('ipcMain.handle("check-whisper-model-downloaded"');
  assert.ok(start > -1 && end > start, "could not locate the retranscribe handler");
  return source.slice(start, end);
})();

test("the handler delegates to the shared re-transcription module", () => {
  assert.match(HANDLER_SOURCE, /retranscribeNoteTranscript\(/);
});

test("the handler cannot write a bare transcription result as the transcript", () => {
  // The old bug in one line: `let finalTranscript = rawText` followed by an
  // unconditional updateNote({ transcript: finalTranscript }).
  assert.doesNotMatch(HANDLER_SOURCE, /finalTranscript/);
  assert.doesNotMatch(HANDLER_SOURCE, /transcribeLocalWhisper/);

  const transcriptWrites = HANDLER_SOURCE.match(/transcript:\s*([A-Za-z_.]+)/g) || [];
  assert.deepEqual(
    transcriptWrites,
    ["transcript: result.transcript"],
    "the only transcript written must be the module's structured output"
  );
});

test("the handler reports a preserved outcome instead of silently succeeding", () => {
  assert.match(HANDLER_SOURCE, /preserved:\s*true/);
  assert.match(HANDLER_SOURCE, /retranscribe_outcome:\s*result\.reason/);
});

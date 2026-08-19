const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/helpers/pasteLastTranscription.js");

function recordingPaste(calls, result = true) {
  return async (text) => {
    calls.push(text);
    return result;
  };
}

test("pastes the newest history entry through the injected seam", async () => {
  const { pasteLastTranscription } = await load();
  const pasted = [];
  const result = await pasteLastTranscription({
    getTranscriptions: async () => [
      { id: 3, text: "most recent words" },
      { id: 2, text: "older words" },
    ],
    paste: recordingPaste(pasted),
  });
  assert.deepEqual(pasted, ["most recent words"]);
  assert.deepEqual(result, { status: "pasted", text: "most recent words" });
});

test("returns empty and never pastes when history has no rows", async () => {
  const { pasteLastTranscription } = await load();
  const pasted = [];
  const result = await pasteLastTranscription({
    getTranscriptions: async () => [],
    paste: recordingPaste(pasted),
  });
  assert.deepEqual(pasted, []);
  assert.deepEqual(result, { status: "empty" });
});

test("returns empty when the history call resolves to a non-array", async () => {
  const { pasteLastTranscription } = await load();
  const pasted = [];
  const result = await pasteLastTranscription({
    getTranscriptions: async () => undefined,
    paste: recordingPaste(pasted),
  });
  assert.deepEqual(pasted, []);
  assert.deepEqual(result, { status: "empty" });
});

test("skips rows with blank or non-string text and pastes the first usable one", async () => {
  const { pasteLastTranscription } = await load();
  const pasted = [];
  const result = await pasteLastTranscription({
    getTranscriptions: async () => [
      { id: 5, text: "   " },
      { id: 4, text: null },
      { id: 3 },
      { id: 2, text: "first usable entry" },
    ],
    paste: recordingPaste(pasted),
  });
  assert.deepEqual(pasted, ["first usable entry"]);
  assert.equal(result.status, "pasted");
});

test("returns empty when every row is blank instead of pasting whitespace", async () => {
  const { pasteLastTranscription } = await load();
  const pasted = [];
  const result = await pasteLastTranscription({
    getTranscriptions: async () => [{ text: "" }, { text: " \n " }],
    paste: recordingPaste(pasted),
  });
  assert.deepEqual(pasted, []);
  assert.deepEqual(result, { status: "empty" });
});

test("returns error and never pastes when the history read rejects", async () => {
  const { pasteLastTranscription } = await load();
  const pasted = [];
  const failure = new Error("db gone");
  const result = await pasteLastTranscription({
    getTranscriptions: async () => {
      throw failure;
    },
    paste: recordingPaste(pasted),
  });
  assert.deepEqual(pasted, []);
  assert.equal(result.status, "error");
  assert.equal(result.error, failure);
});

test("reports paste-failed when the seam declines the paste", async () => {
  const { pasteLastTranscription } = await load();
  const pasted = [];
  const result = await pasteLastTranscription({
    getTranscriptions: async () => [{ text: "words" }],
    paste: recordingPaste(pasted, false),
  });
  assert.deepEqual(pasted, ["words"]);
  assert.deepEqual(result, { status: "paste-failed" });
});

test("returns unavailable when either dependency is missing", async () => {
  const { pasteLastTranscription } = await load();
  assert.deepEqual(await pasteLastTranscription({ paste: async () => true }), {
    status: "unavailable",
  });
  assert.deepEqual(await pasteLastTranscription({ getTranscriptions: async () => [] }), {
    status: "unavailable",
  });
});

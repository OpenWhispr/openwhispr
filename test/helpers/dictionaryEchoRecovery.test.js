const test = require("node:test");
const assert = require("node:assert/strict");

// The pipeline's catch block decides what a discarded dictionary echo costs the
// user. Before #1547 it shared the genuine-silence branch, which suppressed both
// the toast and saveFailedTranscription, so a whole utterance vanished with no
// feedback and no way to retry it.
//
// The dictionary-echo and genuine-silence branches are exercised against the
// REAL processAudio in audioManagerNoAudioLifecycle.test.js; this mirror covers
// only the remaining branch (a real failure) and must track the source's catch
// block in processAudio (src/helpers/audioManager.js).
const settleFailure = (error, manager) => {
  let noAudioDetected = false;
  if (error.code === "DICTIONARY_ECHO") {
    noAudioDetected = true;
    if (manager.lastAudioBlob) {
      manager.saveFailedTranscription(error.message, error.code, {});
    }
  } else if (error.message === "No audio detected") {
    noAudioDetected = true;
  } else {
    manager.onError?.({ description: error.message });
    if (manager.lastAudioBlob) {
      manager.saveFailedTranscription(error.message, error.code || null, {});
    }
  }
  manager.onStateChange?.({ isRecording: false, isProcessing: false });
  if (noAudioDetected) manager.onNoAudio?.();
};

const makeManager = () => {
  const calls = { noAudio: 0, errors: [], saved: [], order: [] };
  return {
    calls,
    lastAudioBlob: {},
    onStateChange: () => calls.order.push("idle"),
    onNoAudio: () => {
      calls.noAudio++;
      calls.order.push("no-audio");
    },
    onError: (payload) => calls.errors.push(payload),
    saveFailedTranscription: (message, code) => calls.saved.push({ message, code }),
  };
};

test("a real failure still reports an error and saves for retry", () => {
  const manager = makeManager();

  settleFailure(new Error("Groq returned 500"), manager);

  assert.equal(manager.calls.noAudio, 0);
  assert.equal(manager.calls.errors.length, 1);
  assert.deepEqual(manager.calls.saved, [{ message: "Groq returned 500", code: null }]);
});

test("every remote dictionary-echo discard is tagged", async () => {
  const fs = require("fs");
  const source = fs.readFileSync("src/helpers/audioManager.js", "utf-8");

  // Each isDictionaryEcho guard must throw the tagged error; a plain
  // `new Error("No audio detected")` there would be swallowed again.
  //
  // Local Whisper now separates detection from the tagged failure so it can
  // attempt recovery first; its failure behavior is covered end-to-end by the
  // AudioManager dictionary-prompt recovery suite.
  const guards = source.match(/isDictionaryEcho\([\s\S]{0,400}?throw [^;]+;/g) ?? [];
  assert.ok(guards.length >= 3, `expected the known remote echo guards, found ${guards.length}`);
  for (const guard of guards) {
    assert.match(guard, /throw dictionaryEchoError\(\);/);
  }
});

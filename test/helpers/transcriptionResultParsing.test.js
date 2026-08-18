const test = require("node:test");
const assert = require("node:assert/strict");

const WhisperManager = require("../../src/helpers/whisper.js");
const ParakeetManager = require("../../src/helpers/parakeet.js");

// "No audio detected" must mean exactly that: the engine decoded the recording
// and found silence. A malformed or error response is an engine failure and has
// to surface as one — reporting it as silence sends users debugging their mic.

const whisper = new WhisperManager();
const parakeet = new ParakeetManager();

test("whisper: blank server text is genuine silence", () => {
  assert.deepEqual(whisper.parseWhisperResult({ text: "" }), {
    success: false,
    message: "No audio detected",
  });
  assert.deepEqual(whisper.parseWhisperResult({ text: " [BLANK_AUDIO] " }), {
    success: false,
    message: "No audio detected",
  });
});

test("whisper: blank CLI transcription is genuine silence", () => {
  assert.deepEqual(whisper.parseWhisperResult({ transcription: [{ text: "" }] }), {
    success: false,
    message: "No audio detected",
  });
});

test("whisper: real text passes through with normalized whitespace", () => {
  assert.deepEqual(whisper.parseWhisperResult({ text: "hello\nworld " }), {
    success: true,
    text: "hello world",
  });
});

test("whisper: a response with neither text nor transcription is an engine failure, not silence", () => {
  const result = whisper.parseWhisperResult({ status: "loading" });
  assert.equal(result.success, false);
  assert.equal(result.error, "invalid_response");
  assert.notEqual(result.message, "No audio detected");
});

test("whisper: a server-reported error is surfaced verbatim", () => {
  const result = whisper.parseWhisperResult({ error: "failed to load model" });
  assert.equal(result.error, "invalid_response");
  assert.match(result.message, /failed to load model/);
});

test("parakeet: present-but-empty transcript is genuine silence", () => {
  assert.deepEqual(parakeet.parseParakeetResult({ text: "  " }), {
    success: false,
    message: "No audio detected",
  });
});

test("parakeet: missing output or text field is an engine failure, not silence", () => {
  for (const output of [null, {}, { text: 42 }]) {
    const result = parakeet.parseParakeetResult(output);
    assert.equal(result.success, false);
    assert.equal(result.error, "invalid_response");
    assert.notEqual(result.message, "No audio detected");
  }
});

test("parakeet: truncated decode keeps its warning", () => {
  assert.deepEqual(parakeet.parseParakeetResult({ text: "hi", truncated: true }), {
    success: true,
    text: "hi",
    warning: "truncated",
  });
});

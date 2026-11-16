const test = require("node:test");
const assert = require("node:assert/strict");

const WhisperManager = require("../../src/helpers/whisper.js");
const ParakeetManager = require("../../src/helpers/parakeet.js");
const { parseSrtResponse } = require("../../src/helpers/whisperServer.js");

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

test("whisper: segments keep their times and drop blank markers", () => {
  const result = whisper.parseWhisperResult({
    text: " Hallo, hier ist Lars.\n Ich habe hier eine Testdatei.",
    segments: [
      { id: 0, start: 1.83, end: 5.51, text: " Hallo, hier ist Lars.", words: [] },
      { id: 1, start: 6.6, end: 15.24, text: " Ich habe hier eine Testdatei.", words: [] },
      { id: 2, start: 15.3, end: 16, text: " [BLANK_AUDIO]", words: [] },
    ],
  });
  assert.deepEqual(result, {
    success: true,
    text: "Hallo, hier ist Lars. Ich habe hier eine Testdatei.",
    segments: [
      { start: 1.83, end: 5.51, text: "Hallo, hier ist Lars." },
      { start: 6.6, end: 15.24, text: "Ich habe hier eine Testdatei." },
    ],
  });
});

test("whisper-server srt becomes text plus timed segments", () => {
  // As the bundled server answers a 15 s meeting chunk.
  const srt =
    "1\n00:00:00,030 --> 00:00:07,980\n consulting. Ich habe hier eine Testdatei.\n\n" +
    "2\n00:00:07,980 --> 00:01:15,010\n Wie gesagt,\n mein Name ist Lars.\n\n";
  assert.deepEqual(parseSrtResponse(srt), {
    text: " consulting. Ich habe hier eine Testdatei. Wie gesagt,  mein Name ist Lars.",
    segments: [
      { start: 0.03, end: 7.98, text: " consulting. Ich habe hier eine Testdatei." },
      { start: 7.98, end: 75.01, text: " Wie gesagt,  mein Name ist Lars." },
    ],
  });
  assert.deepEqual(whisper.parseWhisperResult(parseSrtResponse(srt)).segments[1], {
    start: 7.98,
    end: 75.01,
    text: "Wie gesagt, mein Name ist Lars.",
  });
});

test("whisper-server srt for silence is no audio, not an engine failure", () => {
  assert.deepEqual(whisper.parseWhisperResult(parseSrtResponse("\n")), {
    success: false,
    message: "No audio detected",
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

test("parakeet: completed empty transcript carries the no-speech code and legacy message", () => {
  for (const text of ["", "  \n\t"]) {
    assert.deepEqual(parakeet.parseParakeetResult({ text }), {
      success: false,
      code: "NO_SPEECH_DETECTED",
      message: "No audio detected",
    });
  }
});

test("parakeet: missing output or text field is an engine failure, not silence", () => {
  for (const output of [null, {}, { text: 42 }, { error: "failed to load model" }]) {
    const result = parakeet.parseParakeetResult(output);
    assert.equal(result.success, false);
    assert.equal(result.error, "invalid_response");
    assert.notEqual(result.code, "NO_SPEECH_DETECTED");
    assert.notEqual(result.message, "No audio detected");
  }
});

test("parakeet: entirely truncated output is a decode failure, not no speech", () => {
  const result = parakeet.parseParakeetResult({ text: "  ", truncated: true });
  assert.equal(result.success, false);
  assert.equal(result.error, "invalid_response");
  assert.notEqual(result.code, "NO_SPEECH_DETECTED");
  assert.notEqual(result.message, "No audio detected");
});

test("parakeet: execution failures and cancellation retain their original errors", async () => {
  const manager = new ParakeetManager();
  for (const failure of [
    new Error("FFmpeg conversion failed"),
    new Error("parakeet-ws transcription timed out"),
    Object.assign(new Error("Transcription cancelled"), { name: "AbortError" }),
  ]) {
    manager.serverManager = {
      isAvailable: () => true,
      isModelDownloaded: () => true,
      transcribe: async () => {
        throw failure;
      },
    };
    await assert.rejects(manager.transcribeLocalParakeet(Buffer.from([1])), (error) => {
      assert.equal(error, failure);
      assert.notEqual(error.code, "NO_SPEECH_DETECTED");
      return true;
    });
  }
});

test("parakeet: truncated decode keeps its warning", () => {
  assert.deepEqual(parakeet.parseParakeetResult({ text: "hi", truncated: true }), {
    success: true,
    text: "hi",
    warning: "truncated",
  });
});

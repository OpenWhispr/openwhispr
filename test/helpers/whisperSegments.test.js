const test = require("node:test");
const assert = require("node:assert/strict");

const WhisperManager = require("../../src/helpers/whisper");

// Re-transcription can only rebuild a speaker-labelled transcript if it gets
// per-segment timestamps back. whisper-server only returns them under
// response_format=verbose_json, which the app never asked for — so every
// re-transcription flattened the transcript to plain text.
function createManager() {
  return Object.create(WhisperManager.prototype);
}

test("parseWhisperResult passes verbose_json segments through", () => {
  const manager = createManager();

  const parsed = manager.parseWhisperResult({
    text: " Hello there.\n The fox jumps.\n",
    segments: [
      { id: 0, start: 0, end: 2.7, text: " Hello there." },
      { id: 1, start: 3.08, end: 5.48, text: " The fox  jumps." },
    ],
  });

  assert.equal(parsed.success, true);
  assert.deepEqual(parsed.segments, [
    { start: 0, end: 2.7, text: "Hello there." },
    { start: 3.08, end: 5.48, text: "The fox jumps." },
  ]);
});

test("parseWhisperResult omits segments when the server did not send them", () => {
  const manager = createManager();

  const parsed = manager.parseWhisperResult({ text: "Hello there." });

  assert.equal(parsed.success, true);
  assert.equal(parsed.segments, undefined);
});

test("parseWhisperResult drops empty segments but keeps the transcript", () => {
  const manager = createManager();

  const parsed = manager.parseWhisperResult({
    text: " Hello there.",
    segments: [
      { start: 0, end: 1, text: "   " },
      { start: 1, end: 2, text: " Hello there." },
    ],
  });

  assert.deepEqual(parsed.segments, [{ start: 1, end: 2, text: "Hello there." }]);
});

test("blank audio is still rejected even when segments are present", () => {
  const manager = createManager();

  const parsed = manager.parseWhisperResult({
    text: "[BLANK_AUDIO]",
    segments: [{ start: 0, end: 1, text: "[BLANK_AUDIO]" }],
  });

  assert.equal(parsed.success, false);
});

test("includeSegments asks whisper-server for verbose_json; default stays json", async () => {
  const WhisperServerManager = require("../../src/helpers/whisperServer");
  const server = Object.create(WhisperServerManager.prototype);

  const requestedFormats = [];
  // Capture the multipart body without opening a socket.
  server.ready = true;
  server.process = {};
  server.canConvert = true;
  server._convertToWav = async (buf) => buf;
  server._sendRequest = async (body) => {
    const match = /name="response_format"\r\n\r\n(\w+)\r\n/.exec(body.toString("latin1"));
    requestedFormats.push(match?.[1]);
    return { text: "hi" };
  };

  await server.transcribe(Buffer.from("fake"), {});
  await server.transcribe(Buffer.from("fake"), { includeSegments: true });

  assert.deepEqual(requestedFormats, ["json", "verbose_json"]);
});

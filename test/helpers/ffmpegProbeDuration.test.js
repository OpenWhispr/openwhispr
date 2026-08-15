const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const { EventEmitter } = require("node:events");

const ffmpegModulePath = require.resolve("../../src/helpers/ffmpegUtils");
const originalLoad = Module._load;

// Every ffmpeg invocation the probe makes, so the tests can assert that the
// expensive decode pass runs only when the cheap header pass came up empty.
const spawns = [];
let stderrFor = () => "";

const spawnStub = (_command, args) => {
  spawns.push(args);
  const proc = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.kill = () => {};
  queueMicrotask(() => {
    proc.stderr.emit("data", Buffer.from(stderrFor(args)));
    proc.emit("close", 1); // `ffmpeg -i` with no output always exits non-zero
  });
  return proc;
};

Module._load = function loadWithMocks(request, parent, isMain) {
  // Only the spawn is stubbed. getFFmpegPath still resolves the real bundled
  // binary, because it verifies the path exists before returning it — but that
  // binary is never executed here.
  if (parent?.filename === ffmpegModulePath && request === "child_process") {
    return { spawn: spawnStub };
  }
  return originalLoad.call(this, request, parent, isMain);
};

const { probeAudioDuration, clearCache } = require("../../src/helpers/ffmpegUtils");

test.after(() => {
  Module._load = originalLoad;
});

test.beforeEach(() => {
  spawns.length = 0;
  clearCache();
});

const isDecodePass = (args) => args.includes("null");

test("a container that reports its duration is answered from the header alone", async () => {
  stderrFor = () => "Duration: 00:00:12.50, start: 0.000000";

  assert.equal(await probeAudioDuration("/tmp/recording.mp3"), 12.5);
  assert.equal(spawns.length, 1, "a usable header must not trigger a decode pass");
  assert.equal(isDecodePass(spawns[0]), false);
});

// The regression: dictation audio comes from MediaRecorder as streaming WebM,
// whose header carries no duration. Reading only the header reported "unknown",
// which the Sarvam path treated as "short enough to send whole" — so every
// recording over 30s went to the API intact and came back rejected.
test("streaming WebM with no header duration falls back to decoding", async () => {
  stderrFor = (args) =>
    isDecodePass(args)
      ? "Duration: N/A\nsize=0kB time=00:00:00.00\nsize=N/A time=00:00:47.12 speed=983x"
      : "Duration: N/A, start: 0.000000, bitrate: N/A";

  assert.equal(await probeAudioDuration("/tmp/dictation.webm"), 47.12);
  assert.equal(spawns.length, 2);
  assert.deepEqual(spawns[1], ["-i", "/tmp/dictation.webm", "-f", "null", "-"]);
});

test("an unreadable duration resolves null instead of rejecting", async () => {
  stderrFor = () => "Duration: N/A";

  // The caller sizes a request against an API limit; an inconclusive probe has
  // to degrade to "send it unmodified", never to a thrown error.
  assert.equal(await probeAudioDuration("/tmp/silence.webm"), null);
  assert.equal(spawns.length, 2);
});

test("an already-aborted signal skips ffmpeg entirely", async () => {
  stderrFor = () => "Duration: 00:00:12.50";

  assert.equal(
    await probeAudioDuration("/tmp/recording.mp3", { signal: AbortSignal.abort() }),
    null
  );
  assert.equal(spawns.length, 0);
});

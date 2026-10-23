const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const micGate = require("../../src/helpers/meetingMicGate");

// Runs the real mic alignment and sendMeetingAudio from ipcHandlers.js with
// only the echo detector, the watchdog and the stream dispatch replaced.
const source = fs.readFileSync(path.join(__dirname, "../../src/helpers/ipcHandlers.js"), "utf8");

const sliceBetween = (startMarker, endMarker) => {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  assert.ok(start >= 0 && end > start, `${startMarker} not found in ipcHandlers.js`);
  return source.slice(start, end);
};

function harness() {
  let now = 1_000_000;
  const dispatched = [];
  const context = {
    Buffer,
    _audioFeaturePolicy: { failure: () => null },
    Date: { now: () => now },
    ...micGate,
    meetingPendingMicChunks: [],
    meetingSystemAudioStrategy: null,
    meetingSystemChunkReceivedAt: null,
    meetingAecEnabled: false,
    meetingLocalMode: false,
    meetingLiveSpeakerActive: false,
    meetingDiarizationStream: { write() {} },
    meetingSystemAudioHeard: true,
    meetingSystemAudioWatchdog: { recordChunk() {} },
    meetingEchoLeakDetector: {
      recordSystemChunk() {},
      analyzeMicChunk: () => ({ shouldMute: false }),
    },
    dispatchMeetingAudioBuffer: (buffer, source) => {
      if (source === "mic") dispatched.push(String(buffer));
    },
  };
  vm.createContext(context);
  vm.runInContext(
    `
    ${sliceBetween("const MEETING_MIC_REFERENCE_ALIGNMENT_MS =", "const MEETING_STARTUP_WARMUP_MS =")}
    ${sliceBetween("const flushPendingMeetingMicChunks =", "const stopLiveSpeakerIdentification =")}
    ${sliceBetween("const sendMeetingAudio =", "// The Windows helper reports capture_silent")}
    globalThis.api = {
      setStrategy: setMeetingSystemAudioStrategy,
      system: () => sendMeetingAudio(Buffer.alloc(4), "system"),
      mic: (text) => sendMeetingAudio(Buffer.from(text), "mic"),
    };
    `,
    context
  );
  return {
    api: context.api,
    dispatched,
    advance: (ms) => {
      now += ms;
    },
  };
}

test("each capture holds the mic only as long as its reference lags", () => {
  for (const [strategy, holdMs] of [
    ["native", 320],
    ["wasapi-loopback", 100],
    ["pipewire-loopback", 100],
    ["loopback", 0],
    ["unsupported", 0],
  ]) {
    const { api, dispatched, advance } = harness();
    api.setStrategy(strategy);
    api.system();
    api.mic("a");
    if (holdMs > 0) {
      advance(holdMs - 1);
      api.system();
      assert.deepEqual(dispatched, [], strategy);
      advance(1);
      api.system();
    }
    assert.deepEqual(dispatched, ["a"], strategy);
  }
});

test("a reference that went quiet stops holding the mic, releasing what it held first", () => {
  const { api, dispatched, advance } = harness();
  api.setStrategy("wasapi-loopback");
  api.system();
  api.mic("a");

  advance(1000);
  api.mic("b");

  assert.deepEqual(dispatched, ["a", "b"]);
});

test("a capture that falls back releases the mic it was holding", () => {
  const { api, dispatched } = harness();
  api.setStrategy("wasapi-loopback");
  api.system();
  api.mic("a");
  api.mic("b");
  assert.deepEqual(dispatched, []);

  api.setStrategy("loopback");

  assert.deepEqual(dispatched, ["a", "b"]);
});

test("a fallback releases held mic even after the wall clock steps back", () => {
  const { api, dispatched, advance } = harness();
  api.setStrategy("wasapi-loopback");
  api.system();
  api.mic("a");

  advance(-5000);
  api.setStrategy("loopback");

  assert.deepEqual(dispatched, ["a"]);
});

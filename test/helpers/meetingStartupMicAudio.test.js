const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

// Mic audio the renderer held while main connected arrives in one burst. These
// run the real ipcHandlers.js code paths (sliced, as meetingSystemAudioDegrade
// does) to pin that it is placed at its capture time, not its arrival.
const source = fs.readFileSync(path.join(__dirname, "../../src/helpers/ipcHandlers.js"), "utf8");

const sliceBetween = (startMarker, endMarker) => {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  assert.ok(start >= 0 && end > start, `${startMarker} not found in ipcHandlers.js`);
  return source.slice(start, end);
};

const maxAgeMs = Number(
  /MEETING_STARTUP_AUDIO_MAX_AGE_MS = ([\d_]+);/.exec(source)[1].replace(/_/g, "")
);
const CHUNK = Buffer.alloc(480);

function harness() {
  const events = [];
  const handlers = {};
  const context = {
    Buffer,
    Date,
    path,
    os: { tmpdir: () => "/tmp" },
    fs: { createWriteStream: () => ({ write() {} }) },
    MEETING_STARTUP_AUDIO_MAX_AGE_MS: maxAgeMs,
    MEETING_MIC_REFERENCE_ALIGNMENT_MS: { native: 400 },
    meetingSystemAudioStrategy: "native",
    meetingSystemAudioHeard: false,
    meetingMicDiarizationStream: null,
    meetingMicDiarizationPath: null,
    meetingMicDiarizationStartedAt: null,
    meetingPendingMicChunks: [],
    meetingAecEnabled: false,
    meetingLocalMode: false,
    meetingSystemAudioHandover: { acceptRendererChunk: () => "send" },
    _audioFeaturePolicy: { activeFailure: () => null },
    meetingDetectionEngine: null,
    processMeetingMicWithAec: () => false,
    meetingMicNeedsReferenceAlignment: () => true,
    meetingEchoLeakDetector: {
      analyzeMicChunk: (_buffer, at) => {
        events.push(["analyze", at]);
        return null;
      },
    },
    dispatchMeetingAudioBuffer: (_buffer, source, _synthetic, capturedAt) =>
      events.push(["dispatch", source, capturedAt]),
    ipcMain: { on: (channel, handler) => (handlers[channel] = handler) },
  };
  vm.createContext(context);
  vm.runInContext(
    `${sliceBetween("const flushPendingMeetingMicChunks =", "const meetingMicNeedsReferenceAlignment =")}
    ${sliceBetween("const sendMeetingAudio =", "// The Windows helper reports")}
    ${sliceBetween('ipcMain.on("meeting-transcription-send"', "this._stopMeetingForPolicy =")}`,
    context
  );
  return {
    context,
    events,
    send: (capturedAt) => handlers["meeting-transcription-send"]({}, CHUNK, "mic", capturedAt),
  };
}

test("buffered startup mic audio anchors the in-person timeline at its capture time", () => {
  const { context, events, send } = harness();
  const capturedAt = Date.now() - 5000;
  send(capturedAt);
  assert.equal(context.meetingMicDiarizationStartedAt, capturedAt);
  // Analysed under its capture time and released at once: its reference would
  // have arrived long ago.
  assert.deepEqual(events, [
    ["analyze", capturedAt],
    ["dispatch", "mic", capturedAt],
  ]);

  events.length = 0;
  send(undefined);
  assert.deepEqual(events, [], "live audio still waits for its system reference");
});

test("a renderer's capture time is clamped to the connect window", () => {
  for (const [offset, expected] of [
    [60_000, 0],
    [-10 * maxAgeMs, -maxAgeMs],
  ]) {
    const { context, send } = harness();
    const before = Date.now();
    send(before + offset);
    const anchor = context.meetingMicDiarizationStartedAt - before;
    assert.ok(Math.abs(anchor - expected) < 1000, `offset ${offset} anchored at ${anchor}`);
  }
  const { context, send } = harness();
  const before = Date.now();
  send("not a time");
  assert.ok(context.meetingMicDiarizationStartedAt >= before);
});

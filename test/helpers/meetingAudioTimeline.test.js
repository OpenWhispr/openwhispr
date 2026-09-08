const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");
const createWatchdog = require("../../src/helpers/meetingSystemAudioWatchdog");
const micGate = require("../../src/helpers/meetingMicGate");

// Execute the real IPC closures with only their native/network boundaries replaced.
const ipcPath = path.join(__dirname, "../../src/helpers/ipcHandlers.js");
const source = fs.readFileSync(ipcPath, "utf8");
function section(from, to) {
  return source.slice(source.indexOf(from), source.indexOf(to));
}
function harness({ native = true, local = false } = {}) {
  let now = 0;
  let onChunk;
  const pcm = [];
  const live = [];
  const streamed = [];
  const observed = [];
  const echo = [];
  const aec = [];
  const capture = {
    start: async (callbacks) => {
      onChunk = callbacks.onChunk;
    },
    stop: async () => {},
  };
  const watchdog = createWatchdog({ now: () => now });
  const watchdogChunks = [];
  const recordChunk = watchdog.recordChunk;
  watchdog.recordChunk = (audible) => {
    watchdogChunks.push(audible);
    recordChunk(audible);
  };
  const context = {
    require: (specifier) => {
      const imported = createRequire(ipcPath)(specifier);
      return specifier === "./meetingAudioTimeline" ? () => imported({ now: () => now }) : imported;
    },
    Buffer,
    path,
    Date: { now: () => now },
    performance: { now: () => now },
    BrowserWindow: { fromWebContents: () => null },
    debugLogger: { warn() {}, debug() {}, error() {} },
    meetingDetectionEngine: { recordMeetingAudioChunk: (_, buffer) => observed.push(buffer) },
    audioTapManager: native ? capture : {},
    meetingAecManager: {
      processSystemBuffer: (buffer) => {
        aec.push(buffer);
        return true;
      },
    },
    meetingSystemAudioWatchdog: watchdog,
    meetingEchoLeakDetector: { recordSystemChunk: (buffer) => echo.push(buffer) },
    meetingAecEnabled: true,
    flushPendingMeetingMicChunks() {},
    meetingLiveSpeakerActive: true,
    meetingLiveSpeakerStartedAt: null,
    liveSpeakerIdentifier: { feedAudio: (buffer) => live.push(buffer) },
    meetingDiarizationStream: null,
    meetingDiarizationStartedAt: null,
    meetingDiarizationPath: null,
    fs: { createWriteStream: () => ({ write: (buffer) => pcm.push(buffer) }) },
    meetingSystemAudioHeard: false,
    dropMeetingMicDiarizationCapture() {},
    ...micGate,
    meetingLocalMode: local,
    meetingLocalBuffers: { mic: [], system: [] },
    meetingSendCounts: { mic: 0, system: 0 },
    _meetingSystemStreaming: { sendAudio: (buffer) => streamed.push(buffer) },
    queueMeetingReconnectAudio() {},
    capture,
  };
  vm.createContext(context);
  vm.runInContext(
    `
    ${section("const dispatchMeetingAudioBuffer =", "const stopMeetingAec =")}
    ${section("const sendMeetingAudio =", "// The Windows helper reports capture_silent")}
    ${section("const startManagedMeetingSystemAudio =", "const fallBackToMicOnly =")}
    globalThis.startCapture = () => startManagedMeetingSystemAudio({ sender: {} }, capture, "warning");
  `,
    context
  );
  return {
    context,
    watchdog,
    watchdogChunks,
    pcm,
    live,
    streamed,
    observed,
    echo,
    aec,
    at: (value) => {
      now = value;
    },
    start: context.startCapture,
    chunk: (durationMs = 100, silent = false) =>
      onChunk(Buffer.alloc(durationMs * 48, silent ? 0 : 1)),
    restart: async () => {
      watchdog.reportDeviceInvalidated();
      await new Promise(setImmediate);
    },
  };
}
const bytes = (buffers) => buffers.reduce((total, buffer) => total + buffer.length, 0);

test("real watchdog recovery preserves the missing seconds for diarization, live ID and streaming", async () => {
  const run = harness();
  await run.start();
  run.watchdog.start({ systemAudioStrategy: "native", watchesDelivery: true });
  run.chunk();
  run.watchdog.tick();
  for (const at of [2000, 4000, 6000, 8000]) {
    run.at(at);
    run.watchdog.tick();
  }
  await new Promise(setImmediate);
  run.at(8250);
  run.chunk();
  // Chunk starts at 8.25s: 0.1s recorded + 8.15s missing + 0.1s recovered.
  for (const buffers of [run.pcm, run.live, run.streamed]) {
    assert.equal(bytes(buffers), 400800);
    assert.ok(buffers.slice(1, -1).every((buffer) => buffer.every((value) => value === 0)));
    assert.ok(buffers.every((buffer) => buffer.length <= 48000));
  }
  assert.equal(run.observed.length, 2);
  assert.equal(run.watchdogChunks.length, 2);
  assert.equal(run.echo.length, 2);
  assert.equal(run.aec.length, 2);
  assert.equal(run.context.meetingSendCounts.system, 2);
  run.watchdog.stop();
});

test("normal jitter, buffered bursts and actual silence never insert synthetic audio", async () => {
  const run = harness();
  await run.start();
  run.chunk();
  run.at(2500);
  run.chunk(1000, true);
  run.chunk(1500);
  assert.equal(bytes(run.pcm), 124800);
  assert.equal(run.pcm.length, 3);
});

test("repeated recovery pads only the remaining deficit and a new capture resets the timeline", async () => {
  const run = harness();
  await run.start();
  run.watchdog.start({ systemAudioStrategy: "native", watchesDelivery: true });
  run.chunk();
  run.at(2000);
  await run.restart();
  run.at(2200);
  run.chunk(100, true);
  run.at(3000);
  await run.restart();
  run.at(3500);
  run.chunk();
  assert.equal(bytes(run.pcm), 172800);
  run.watchdog.stop();
  await run.start();
  run.at(100000);
  run.chunk();
  assert.equal(bytes(run.pcm), 177600);
});

test("a restart before the first packet does not move the first-packet anchor", async () => {
  const run = harness();
  await run.start();
  run.watchdog.start({ systemAudioStrategy: "native", watchesDelivery: true });
  run.at(2000);
  await run.restart();
  run.at(3000);
  run.chunk();
  assert.equal(bytes(run.pcm), 4800);
  assert.equal(run.context.meetingDiarizationStartedAt, 3000);
});

test("other native platform helpers keep their existing idle-gap behavior", async () => {
  const run = harness({ native: false });
  await run.start();
  run.watchdog.start({ systemAudioStrategy: "wasapi-loopback" });
  run.chunk();
  run.at(10000);
  await run.restart();
  run.chunk();
  assert.equal(bytes(run.pcm), 9600);
});

test("local transcription excludes synthetic silence while diarization retains the gap", async () => {
  const run = harness({ local: true });
  await run.start();
  run.watchdog.start({ systemAudioStrategy: "native", watchesDelivery: true });
  run.chunk();
  run.at(10000);
  await run.restart();
  run.chunk();
  assert.equal(bytes(run.context.meetingLocalBuffers.system), 9600);
  assert.equal(bytes(run.pcm), 484800);
});

test("restarts without packets are padded only once when audio finally arrives", async () => {
  const run = harness();
  await run.start();
  run.watchdog.start({ systemAudioStrategy: "native", watchesDelivery: true });
  run.chunk();
  run.at(2000);
  await run.restart();
  run.at(12000);
  await run.restart();
  run.at(15000);
  run.chunk();
  run.chunk();
  assert.equal(bytes(run.pcm), 729600);
  assert.equal(run.observed.length, 3);
});

test("a long recovery uses bounded reusable silence rather than a gap-sized allocation", async () => {
  const run = harness();
  await run.start();
  run.watchdog.start({ systemAudioStrategy: "native", watchesDelivery: true });
  run.chunk();
  run.at(2000);
  await run.restart();
  run.at(3600000);
  run.chunk();
  assert.equal(bytes(run.pcm), 172804800);
  const silence = run.pcm.slice(1, -1);
  assert.ok(silence.every((buffer) => buffer.length <= 48000));
  assert.equal(new Set(silence.map((buffer) => buffer.buffer)).size, 1);
});

test("recovery silence plus AssemblyAI's pending partial packet stays within its frame limit", () => {
  const AssemblyAiStreaming = require("../../src/helpers/assemblyAiStreaming");
  const createTimeline = require("../../src/helpers/meetingAudioTimeline");
  let now = 0;
  const timeline = createTimeline({ now: () => now });
  const streaming = new AssemblyAiStreaming();
  const frames = [];
  streaming.ws = { readyState: 1, send: (frame) => frames.push(frame) };
  const send = (buffer) => streaming.sendAudio(buffer);
  timeline.write(Buffer.alloc(960, 1), send); // 20ms, below the provider's flush threshold.
  assert.equal(frames.length, 0);
  timeline.markRestart();
  now = 2020;
  timeline.write(Buffer.alloc(4800, 2), send);
  assert.ok(
    frames.every((frame) => frame.length <= 48000),
    "24kHz frames must not exceed 1000ms"
  );
  const output = Buffer.concat(frames);
  assert.equal(output.length, 101760); // 20ms real + 2000ms missing + 100ms real.
  assert.ok(output.subarray(0, 960).every((value) => value === 1));
  assert.ok(output.subarray(960, 96960).every((value) => value === 0));
  assert.ok(output.subarray(96960).every((value) => value === 2));
});

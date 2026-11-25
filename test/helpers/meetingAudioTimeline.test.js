const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");
const ElevenLabsStreaming = require("../../src/helpers/elevenLabsStreaming");
const createWatchdog = require("../../src/helpers/meetingSystemAudioWatchdog");
const createMeetingSystemAudioHandover = require("../../src/helpers/meetingSystemAudioHandover");
const micGate = require("../../src/helpers/meetingMicGate");

// Execute the real IPC closures with only their native/network boundaries replaced.
const ipcPath = path.join(__dirname, "../../src/helpers/ipcHandlers.js");
const source = fs.readFileSync(ipcPath, "utf8");
function section(from, to) {
  return source.slice(source.indexOf(from), source.indexOf(to));
}
const MEETING_STARTUP_AUDIO_MAX_AGE_MS = Number(
  /MEETING_STARTUP_AUDIO_MAX_AGE_MS = ([\d_]+);/.exec(source)[1].replace(/_/g, "")
);
function harness({ native = true, local = false } = {}) {
  let now = 0;
  let onChunk;
  const ipc = {};
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
    effectivePolicyManager: { getCurrent: () => ({ success: true, managed: false }) },
    app: { getVersion: () => "1.11.1" },
    productOperationAllowed: require("../../src/helpers/productPolicy").productOperationAllowed,
    meetingConnectionOptions: null,
    meetingClockByPcm: new WeakMap(),
    ...require("../../src/helpers/meetingCaptureClock"),
    require: (specifier) => {
      const imported = createRequire(ipcPath)(specifier);
      return specifier === "./meetingAudioTimeline"
        ? () => imported({ now: () => now, wallNow: () => now })
        : imported;
    },
    Buffer,
    _audioFeaturePolicy: { failure: () => null, activeFailure: () => null },
    path,
    Date: { now: () => now },
    performance: { now: () => now },
    BrowserWindow: { fromWebContents: () => null },
    debugLogger: { warn() {}, debug() {}, error() {}, info() {} },
    meetingDetectionEngine: { recordMeetingAudioChunk: (_, buffer) => observed.push(buffer) },
    audioTapManager: native ? capture : {},
    meetingAecManager: {
      processSystemBuffer: (buffer) => {
        aec.push(buffer);
        return true;
      },
    },
    meetingSystemAudioWatchdog: watchdog,
    meetingSystemAudioHandover: createMeetingSystemAudioHandover(),
    meetingEchoLeakDetector: {
      recordSystemChunk: (buffer) => echo.push(buffer),
      isSystemSpeaking: () => false,
    },
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
    meetingReconnectAudioBuffers: { mic: [], system: [] },
    meetingReconnectAudioBytes: { mic: 0, system: 0 },
    meetingReconnectReplaySources: new Set(),
    meetingReconnectPromise: null,
    MEETING_RECONNECT_BUFFER_MAX_BYTES: 24000 * 2 * 30,
    MEETING_MIC_BLEED_LOOKBACK_MS: 0,
    meetingMicStatsLogCount: 0,
    MEETING_MIC_STATS_LOG_LIMIT: 0,
    MEETING_STARTUP_AUDIO_MAX_AGE_MS,
    ipcMain: { on: (channel, handler) => (ipc[channel] = handler) },
    capture,
  };
  vm.createContext(context);
  vm.runInContext(
    `
    ${section("const resetMeetingReconnectAudio =", "// Labels the socket for field logs")}
    ${section("const dispatchMeetingAudioBuffer =", "const stopMeetingAec =")}
    ${section("const sendMeetingAudio =", "// The Windows helper reports capture_silent")}
    ${section("const startManagedMeetingSystemAudio =", "const fallBackToMicOnly =")}
    ${section('ipcMain.on("meeting-transcription-send"', "this._stopMeetingForPolicy =")}
    globalThis.dispatchMicAudio = (buffer, capturedAt) =>
      dispatchMeetingAudioBuffer(buffer, "mic", false, capturedAt);
    globalThis.startCapture = () => startManagedMeetingSystemAudio({ sender: {} }, capture, "warning");
    globalThis.replaySystemAudio = (streaming) => replayMeetingReconnectAudio("system", streaming);
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
    rendererSend: (buffer, source, capturedAt) =>
      ipc["meeting-transcription-send"]({}, buffer, source, capturedAt),
    chunk: (durationMs = 100, silent = false, nativeClock) =>
      onChunk(Buffer.alloc(durationMs * 48, silent ? 0 : 1), nativeClock),
    restart: async () => {
      watchdog.reportDeviceInvalidated();
      await new Promise(setImmediate);
    },
  };
}
const bytes = (buffers) => buffers.reduce((total, buffer) => total + buffer.length, 0);

test("a backlog of separate PCM reads preserves the sample timeline and an actual preceding gap", () => {
  const {
    createMeetingCaptureClock,
    captureStartFromDelivery,
  } = require("../../src/helpers/meetingCaptureClock");
  for (const silenceMs of [0, 60000]) {
    const clock = createMeetingCaptureClock();
    const buffer = Buffer.alloc(4800);
    clock.append(buffer, 0);
    // The first block after any real silence arrives on time. A later event-loop
    // stall delivers 34 separate native reads in one turn.
    clock.append(buffer, 100 + silenceMs);
    for (let frame = 2; frame < 51; frame++) {
      const delivery = silenceMs + Math.max(3500, (frame + 1) * 100);
      clock.append(buffer, captureStartFromDelivery(buffer, delivery));
    }
    assert.equal(clock.elapsedMs(100, true), 100);
    assert.equal(clock.elapsedMs(100), 100 + silenceMs);
    assert.equal(clock.elapsedMs(200), 200 + silenceMs);
    assert.equal(clock.elapsedMs(5000), 5000 + silenceMs);
  }
});

test("Sarvam keeps native, buffered renderer and replay audio on the local speaker clock", async () => {
  const run = harness({ native: false });
  await run.start();
  run.context.meetingConnectionOptions = { provider: "sarvam-realtime" };
  run.context.meetingReconnectReplaySources.add("system");
  run.at(1100);
  run.chunk(100);
  // A coalesced native read covers the next two seconds without an idle gap.
  run.at(3100);
  run.chunk(2000);
  // The renderer delivers a saved 100 ms worklet block during recovery.
  run.at(90000);
  run.rendererSend(Buffer.alloc(4800, 1), "system", 61100);
  const captures = [];
  run.context.replaySystemAudio({
    isConnected: true,
    sendAudio: (_, capturedAt) => captures.push(capturedAt),
  });
  assert.deepEqual(captures, [1000, 1100, 61000]);
  const clock = run.context.meetingClockByPcm.get(run.context.meetingDiarizationStream);
  assert.equal(clock.elapsedMs(2100, true), 2100);
  assert.equal(clock.elapsedMs(2100), 60000);
  assert.equal(bytes(run.pcm), 2200 * 48);
  assert.equal(bytes(run.live), 2200 * 48);
});

test("macOS dates the first Sarvam system sample alongside renderer audio, including after a restart", async () => {
  const { SarvamMeetingStreaming } = require("../../src/helpers/sarvamRealtimeStreaming");
  const run = harness();
  await run.start();
  run.context.meetingConnectionOptions = { provider: "sarvam-realtime" };
  const system = new SarvamMeetingStreaming();
  const mic = new SarvamMeetingStreaming();
  const timestamps = [];
  for (const stream of [mic, system]) {
    stream.isConnected = true;
    stream.ws = { bufferedAmount: 0, send() {} };
    stream.onFinalTranscript = (_text, at) => timestamps.push(at);
  }
  run.context._meetingMicStreaming = mic;
  run.context._meetingSystemStreaming = system;
  run.context.processMeetingMicWithAec = (buffer, capturedAt) => {
    run.context.dispatchMicAudio(buffer, capturedAt);
    return true;
  };
  run.watchdog.start({ systemAudioStrategy: "native", watchesDelivery: true });
  run.at(101000);
  run.chunk(1000);
  run.rendererSend(Buffer.alloc(48000, 1), "mic", 101000);
  system.emitFinal("remote first", 0.1);
  mic.emitFinal("then the microphone", 0.4);
  assert.equal(run.context.meetingDiarizationStartedAt, 100000);
  assert.equal(run.context.meetingLiveSpeakerStartedAt, 100000);
  assert.deepEqual(timestamps, [100100, 100400]);
  await run.restart();
  run.at(103100);
  run.chunk(100);
  system.emitFinal("remote resumed", (bytes(run.pcm) - 4800) / 48000);
  assert.deepEqual(timestamps, [100100, 100400, 103000]);
  run.watchdog.stop();
});

test("native capture time survives multiple pipe reads delivered together after a restart", async () => {
  const run = harness();
  await run.start();
  run.context.meetingConnectionOptions = { provider: "sarvam-realtime" };
  run.watchdog.start({ systemAudioStrategy: "native", watchesDelivery: true });
  const times = [];
  run.context._meetingSystemStreaming = { sendAudio: (_buffer, at) => times.push(at) };
  run.at(1100);
  run.chunk(100, false, { hostMs: 1000, epochMs: 1000 });
  await run.restart();
  run.at(4000);
  run.chunk(1000, false, { hostMs: 2000, epochMs: 2000 });
  run.chunk(1000, false, { hostMs: 3000, epochMs: 3000 });
  run.at(4100);
  run.chunk(100, false, { hostMs: 4000, epochMs: 4000 });
  assert.deepEqual(times.slice(-3), [2000, 3000, 4000]);
  assert.equal(bytes(run.pcm) / 48, 3100);
  run.watchdog.stop();
});

function createTimestampedStream(provider, connectedAt) {
  const StreamingClient = require(`../../src/helpers/${provider}Streaming`);
  const streaming = new StreamingClient();
  const frames = [];
  const timestamps = [];
  streaming.ws = { readyState: 1, send: (buffer) => frames.push(buffer) };
  streaming.isConnected = true;
  streaming.configAccepted = true;
  streaming.sessionStartedAt = connectedAt;
  streaming.onFinalTranscript = (_text, timestamp) => timestamps.push(timestamp);
  return {
    streaming,
    frames,
    timestamps,
    finalizeSpeech(afterFrame = 0) {
      const speechStart = frames.findIndex(
        (buffer, index) => index >= afterFrame && buffer.some((value) => value !== 0)
      );
      assert.ok(speechStart >= 0, "the provider must receive the recovered speech");
      const start = bytes(frames.slice(0, speechStart)) / 48000;
      const message =
        provider === "deepgram"
          ? {
              type: "Results",
              is_final: true,
              start,
              channel: { alternatives: [{ transcript: "I am back" }] },
            }
          : { type: "transcript", data: { isFinal: true, start, text: "I am back" } };
      streaming.handleMessage(Buffer.from(JSON.stringify(message)));
    },
  };
}

test("Deepgram anchors native system and AEC mic transcripts to audio after slow setup", async (t) => {
  const run = harness({ native: false });
  await run.start();
  const mic = createTimestampedStream("deepgram", 1000);
  const system = createTimestampedStream("deepgram", 1000);
  run.context._meetingMicStreaming = mic.streaming;
  run.context._meetingSystemStreaming = system.streaming;
  let now = 14000;
  run.at(now);
  t.mock.method(Date, "now", () => now);

  // Windows/Linux native capture and AEC mic output carry no capture-time override.
  run.chunk();
  run.context.dispatchMicAudio(Buffer.alloc(4800, 1));
  mic.finalizeSpeech();
  system.finalizeSpeech();
  assert.deepEqual(mic.timestamps, [14000]);
  assert.deepEqual(system.timestamps, [14000]);
  assert.equal(run.context.meetingDiarizationStartedAt, 14000);
  assert.equal(run.context.meetingLiveSpeakerStartedAt, 14000);

  now = 15000;
  run.at(now);
  run.chunk();
  run.context.dispatchMicAudio(Buffer.alloc(4800, 1));
  mic.finalizeSpeech(1);
  system.finalizeSpeech(1);
  assert.deepEqual(mic.timestamps, [14000, 14100]);
  assert.deepEqual(system.timestamps, [14000, 14100]);
});

function receiveElevenLabsFinal(streaming, start) {
  let received;
  streaming.onFinalTranscript = (text, timestamp) => {
    received = { text, timestamp };
  };
  streaming.handleMessage(
    Buffer.from(
      JSON.stringify({
        message_type: "committed_transcript_with_timestamps",
        text: "I am back",
        words: [{ type: "word", start }],
      })
    )
  );
  return received;
}

test("ElevenLabs times native capture from its first sample after a slow handshake", async (t) => {
  const run = harness({ native: false });
  await run.start();
  t.mock.timers.enable({ apis: ["Date"], now: 3200 });
  const streaming = new ElevenLabsStreaming();
  streaming.sessionStartedAt = 1000;
  streaming.isConnected = true;
  streaming.ws = { readyState: 1, send() {} };
  run.context._meetingSystemStreaming = streaming;
  run.at(3200);
  run.chunk();
  assert.deepEqual(receiveElevenLabsFinal(streaming, 0), { text: "I am back", timestamp: 3200 });
});

test("ElevenLabs times resumed speech from the native capture clock after idle keep-alives", async (t) => {
  const run = harness();
  await run.start();
  t.mock.timers.enable({ apis: ["setInterval", "Date"], now: 1000 });
  const frames = [];
  const streaming = new ElevenLabsStreaming();
  streaming.sessionStartedAt = 1000;
  streaming.isConnected = true;
  streaming.ws = {
    readyState: 1,
    send: (data) => frames.push(Buffer.from(JSON.parse(data).audio_base_64, "base64")),
  };
  run.context._meetingSystemStreaming = streaming;
  run.watchdog.start({ systemAudioStrategy: "native", watchesDelivery: true });
  t.after(() => {
    run.watchdog.stop();
    streaming.stopKeepAlive();
  });
  run.at(1000);
  run.chunk(100);
  streaming.startKeepAlive();
  t.mock.timers.tick(6000);
  assert.ok(frames.length > 1, "socket received idle keep-alive silence");
  run.at(7000);
  await run.restart();
  run.chunk(100);
  const resumedWordStart = bytes(frames.slice(0, -1)) / 48000;
  assert.deepEqual(receiveElevenLabsFinal(streaming, resumedWordStart), {
    text: "I am back",
    timestamp: 6900,
  });
});

for (const provider of ["deepgram", "corti"]) {
  test(`${provider} preserves an established socket's origin across capture recovery`, async () => {
    const run = harness();
    await run.start();
    run.watchdog.start({ systemAudioStrategy: "native", watchesDelivery: true });
    const existing = createTimestampedStream(provider, 0);
    run.context._meetingSystemStreaming = existing.streaming;
    run.at(2000);
    run.chunk(1000);
    const previousFrameCount = existing.frames.length;
    run.at(8000);
    await run.restart();
    run.at(10100);
    run.chunk();
    existing.finalizeSpeech(previousFrameCount);
    assert.deepEqual(existing.timestamps, [10000]);
    assert.equal(existing.streaming.sessionStartedAt, 1000);
    run.watchdog.stop();
  });

  test(`${provider} capture recovery keeps transcript time after the provider reconnects`, async () => {
    const run = harness();
    await run.start();
    run.watchdog.start({ systemAudioStrategy: "native", watchesDelivery: true });
    run.at(1000);
    run.chunk(1000);
    run.at(8000);
    await run.restart();
    const recovered = createTimestampedStream(provider, 8000);
    run.context._meetingSystemStreaming = recovered.streaming;
    run.at(10100);
    run.chunk();
    recovered.finalizeSpeech();
    assert.deepEqual(recovered.timestamps, [10000]);
    assert.equal(bytes(run.pcm), 484800, "diarization retains the entire recording timeline");
    assert.equal(bytes(run.live), 484800);
    run.watchdog.stop();
  });

  test(`${provider} reconnect replay retains the sample origin of recovered audio`, async () => {
    const run = harness();
    await run.start();
    run.watchdog.start({ systemAudioStrategy: "native", watchesDelivery: true });
    run.at(1000);
    run.chunk(1000);
    run.at(8000);
    await run.restart();
    run.context.meetingReconnectReplaySources.add("system");
    run.context._meetingSystemStreaming = { sendAudio: () => false };
    run.at(10100);
    run.chunk();
    const recovered = createTimestampedStream(provider, 12000);
    assert.equal(run.context.replaySystemAudio(recovered.streaming), true);
    recovered.finalizeSpeech();
    assert.deepEqual(recovered.timestamps, [10000]);
    run.watchdog.stop();
  });

  test(`${provider} trimmed reconnect replay uses the first retained sample's origin`, async () => {
    const run = harness();
    await run.start();
    run.watchdog.start({ systemAudioStrategy: "native", watchesDelivery: true });
    run.at(1000);
    run.chunk(1000);
    run.at(8000);
    await run.restart();
    run.context.meetingReconnectReplaySources.add("system");
    run.context.MEETING_RECONNECT_BUFFER_MAX_BYTES = 48000;
    run.context._meetingSystemStreaming = { sendAudio: () => false };
    run.at(10100);
    run.chunk();
    const recovered = createTimestampedStream(provider, 12000);
    assert.equal(run.context.replaySystemAudio(recovered.streaming), true);
    assert.equal(bytes(recovered.frames), 48000);
    recovered.finalizeSpeech();
    assert.deepEqual(recovered.timestamps, [10000]);
    run.watchdog.stop();
  });
}

test("a stream that drops while a reconnect is under way joins its replay", () => {
  const run = harness({ native: false });
  // The mic session expired first and started the reconnect; system was still up then.
  run.context.meetingReconnectReplaySources.add("mic");
  run.context.meetingReconnectPromise = Promise.resolve(true);
  const system = { isConnected: true, sendAudio: () => true };
  run.context._meetingSystemStreaming = system;

  run.rendererSend(Buffer.alloc(4800, 1), "system", 1000);
  assert.equal(
    run.context.meetingReconnectAudioBuffers.system.length,
    0,
    "a live stream is not held"
  );

  system.isConnected = false;
  system.sendAudio = () => false;
  run.rendererSend(Buffer.alloc(4800, 2), "system", 1100);
  run.rendererSend(Buffer.alloc(4800, 3), "system", 1200);

  const replayed = [];
  const replacement = { isConnected: true, sendAudio: (buffer) => replayed.push(buffer[0]) > 0 };
  assert.equal(run.context.replaySystemAudio(replacement), true);
  assert.deepEqual(replayed, [2, 3]);
});

test("a socket that fails inside send retains that PCM for reconnect", async () => {
  const run = harness();
  await run.start();
  run.context._meetingSystemStreaming = {
    isConnected: true,
    sendAudio() {
      this.isConnected = false;
      run.context.meetingReconnectPromise = Promise.resolve();
      return false;
    },
  };
  run.chunk(100);
  assert.equal(run.context.meetingReconnectAudioBytes.system, 4800);
});

test("a dropped stream holds nothing when no reconnect is under way", () => {
  const run = harness({ native: false });
  run.context._meetingSystemStreaming = { isConnected: false, sendAudio: () => false };
  run.rendererSend(Buffer.alloc(4800, 1), "system", 1000);
  assert.equal(run.context.meetingReconnectAudioBuffers.system.length, 0);
});

for (const provider of ["deepgram", "corti"]) {
  test(`${provider} places renderer audio held through the connect at its capture time, mic and system alike`, () => {
    const run = harness({ native: false });
    const mic = createTimestampedStream(provider, 9000);
    const system = createTimestampedStream(provider, 9000);
    run.context._meetingMicStreaming = mic.streaming;
    run.context._meetingSystemStreaming = system.streaming;
    run.at(9000);
    // Both channels were captured from 6000 while main connected, then flushed at once.
    run.context.dispatchMicAudio(Buffer.alloc(4800, 1), 6000);
    run.rendererSend(Buffer.alloc(4800, 1), "system", 6000);
    mic.finalizeSpeech();
    system.finalizeSpeech();
    assert.deepEqual(mic.timestamps, [6000]);
    assert.deepEqual(system.timestamps, [6000]);
    assert.equal(run.context.meetingDiarizationStartedAt, 6000);
    assert.equal(run.context.meetingLiveSpeakerStartedAt, 6000);
  });
}

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
  // The first samples are 8.25s apart, leaving 8.15s between the two 100ms reads.
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
  assert.equal(run.context.meetingDiarizationStartedAt, 2900);
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

test("the macOS tap keeps its arrival anchor for providers that time the mic at arrival", () => {
  const createTimeline = require("../../src/helpers/meetingAudioTimeline");
  const firstChunkAt = (anchorsFirstSample) => {
    const stamps = [];
    const timeline = createTimeline({
      now: () => 0,
      wallNow: () => 10_000,
      anchorsFirstSample: () => anchorsFirstSample,
    });
    // 100 ms of 24 kHz audio, with the helper's capture clock.
    timeline.write(Buffer.alloc(4800), (_buffer, _synthetic, at) => stamps.push(at), {
      hostMs: 0,
      epochMs: 9_850,
    });
    return stamps[0];
  };
  // Sarvam converts the mic to first-sample times too, so it gets the capture clock.
  assert.equal(firstChunkAt(true), 9_850);
  // Any other provider's mic is placed at arrival, so the system track stays with it.
  assert.equal(firstChunkAt(false), 10_000);
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
  now = 2100;
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

test("a meeting restriction drops native audio before transcription, speaker analysis or disk capture", async () => {
  const h = harness();
  await h.start();
  h.context._audioFeaturePolicy.activeFailure = () => ({
    code: "POLICY_MEETING_RECORDING_DISABLED",
  });
  h.chunk();
  assert.equal(bytes(h.streamed), 0);
  assert.equal(bytes(h.pcm), 0);
  assert.equal(bytes(h.live), 0);
  assert.equal(bytes(h.observed), 0);
});

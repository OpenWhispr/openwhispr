const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "../../src/helpers/ipcHandlers.js"), "utf8");

const sliceBetween = (startMarker, endMarker) => {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  assert.ok(start >= 0 && end > start, `${startMarker} not found in ipcHandlers.js`);
  return source.slice(start, end);
};

const deferred = () => {
  let resolve;
  const promise = new Promise((done) => (resolve = done));
  return { promise, resolve };
};

// Arrays made inside the vm context have another realm's prototype.
const plain = (value) => JSON.parse(JSON.stringify(value));

const settle = () => new Promise((resolve) => setImmediate(resolve));

// Runs the real local-meeting stop, rollback and start paths over stubbed
// capture, transcription and diarization so the closure state is observable.
function harness({
  plannedSystemAudio = { mode: "unsupported", strategy: "unsupported" },
  startedStrategy = plannedSystemAudio.strategy,
} = {}) {
  const events = [];
  const sent = [];
  const diarizations = [];
  const chunkGates = [];
  const lateStreamingFinals = [];
  const win = {
    isDestroyed: () => false,
    webContents: { send: (channel, payload) => sent.push({ channel, payload }) },
  };
  const engine = {
    endRecordingSession: () => undefined,
    setUserRecording() {},
    beginRecordingSession: async () => {},
  };
  const context = {
    events,
    chunkGates,
    lateStreamingFinals,
    win,
    plannedSystemAudio,
    startedStrategy,
    debugLogger: { debug() {}, error() {} },
    meetingDetectionEngine: engine,
    windowManager: { controlPanelWindow: null },
    activeMeetingSpeakerConfig: null,
    _startOrSkipDiarization: (...args) => diarizations.push(args),
    _resolveMeetingSpeakerIndexBase: () => 0,
    _resolveInitialMeetingSpeakerConfig: () => null,
    BrowserWindow: { fromWebContents: () => win },
    ALLOWED_MEETING_PROVIDERS: new Set(["local"]),
    LOCAL_MEETING_CHUNK_INTERVAL_MS: 5000,
    credentialGeneration: 0,
    setInterval: () => "local-timer",
    clearInterval: () => {},
  };
  vm.createContext(context);
  vm.runInContext(
    `
    let meetingLocalMode = false;
    let meetingLocalTimer = null;
    let meetingLocalWin = null;
    let meetingLocalBuffers = { mic: [], system: [] };
    let meetingLocalTranscript = "";
    let meetingLocalProvider = null;
    let meetingLocalModel = null;
    let meetingLocalLanguage = null;
    let meetingLocalTranscribePromise = null;
    let meetingDiarizationSegments = [];
    let meetingNoteId = null;
    let meetingSpeakerIndexBase = 0;
    let meetingStartedAt = null;
    let meetingConnectionOptions = null;
    let meetingConnectionWin = null;
    let meetingConnectionKey = null;
    let meetingReconnectCount = 0;
    let meetingFatalErrorSent = false;
    let meetingTranscriptionPreparePromise = null;
    let meetingTranscriptionStartInProgress = false;
    let meetingOneOnOneAttendee = null;
    let meetingOneOnOneProfileBound = false;

    const noop = () => {};
    const asyncNoop = async () => {};
    const clearMeetingSystemAudioSilenceTimer = noop;
    const stopMeetingSystemAudioWatchdog = noop;
    const armMeetingSystemAudioSilenceTimer = noop;
    const startMeetingSystemAudioWatchdog = noop;
    const flushPendingMeetingMicChunks = noop;
    const setMeetingSystemAudioStrategy = (strategy) => events.push("strategy:" + strategy);
    const flushPendingMicFinals = () => events.push("flush");
    const stopMeetingAec = asyncNoop;
    const startMeetingAec = asyncNoop;
    const stopLiveSpeakerIdentification = async () => null;
    const startLiveSpeakerIdentification = asyncNoop;
    const meetingEchoLeakDetector = { reset: noop };
    const resolveOneOnOneAttendeeForNote = () => null;
    const isMeetingStreamingConnected = () => false;
    const getMeetingConnectionKey = () => "local";
    const getMeetingSystemAudioPlan = async () => plannedSystemAudio;
    const startMeetingSystemAudio = async (_event, systemAudioMode) => ({
      systemAudioMode,
      systemAudioStrategy: startedStrategy,
    });
    const toPolicyFailure = (error) => ({ success: false, error: error.message });
    const buildOrderedTranscriptText = (segments) =>
      segments.map((segment) => segment.text).join(" ").trim();

    // Mirrors the real chunk: a final lands in the segment list and goes to
    // the meeting window, whichever session those belong to by then.
    const transcribeLocalMeetingChunk = async (source) => {
      const index = chunkGates.findIndex((gate) => gate.source === source);
      if (index < 0) return;
      const [gate] = chunkGates.splice(index, 1);
      await gate.promise;
      events.push("chunk-done:" + source);
      meetingDiarizationSegments.push({ text: gate.text, source, timestamp: 1 });
      if (meetingLocalWin && !meetingLocalWin.isDestroyed()) {
        meetingLocalWin.webContents.send("meeting-transcription-segment", {
          text: gate.text,
          source,
          type: "final",
        });
      }
    };

    const disconnectMeetingStreaming = async () => {
      events.push("disconnect");
      for (const text of lateStreamingFinals) {
        meetingDiarizationSegments.push({ text, source: "system", timestamp: 2 });
      }
      return [{ text: "" }, { text: "" }];
    };

    const captureMeetingDiarizationState = async () => {
      events.push("capture");
      const diarizationSegments = meetingDiarizationSegments;
      meetingDiarizationSegments = [];
      return {
        diarizationPcmPath: null,
        diarizationSegments,
        diarizationStartedAt: null,
        diarizedSource: null,
      };
    };

    const resetMeetingLocalState = () => {
      events.push("reset");
      meetingLocalTimer = null;
      meetingLocalMode = false;
      meetingLocalWin = null;
      meetingDiarizationSegments = [];
      meetingLocalTranscript = "";
    };

    ${sliceBetween("const transcribeAllLocalBuffers =", "const dropMeetingMicDiarizationCapture =")}
    ${sliceBetween("const rollbackMeetingTranscriptionStart =", "const setupDictationCallbacks =")}
    ${sliceBetween("const startMeetingTranscription =", "const sendMeetingAudio =")}
    ${sliceBetween("const stopMeetingTranscription =", "const meetingTranscriptionLifecycle =")}

    globalThis.api = {
      beginLocalSession() {
        meetingLocalMode = true;
        meetingLocalTimer = "local-timer";
        meetingLocalWin = win;
      },
      timerTick: () => transcribeAllLocalBuffers(),
      stop: (sessionId) => stopMeetingTranscription(sessionId),
      rollback: () => rollbackMeetingTranscriptionStart(),
      start: (options) => startMeetingTranscription({ sender: {} }, options),
      get segments() {
        return meetingDiarizationSegments;
      },
      set segments(value) {
        meetingDiarizationSegments = value;
      },
    };
    `,
    context
  );

  const holdChunk = (text, source = "system") => {
    const gate = { ...deferred(), text, source };
    chunkGates.push(gate);
    return gate;
  };

  return { api: context.api, events, sent, diarizations, holdChunk, lateStreamingFinals };
}

test("stop waits for a timer pass still transcribing before it captures the session", async () => {
  const { api, events, sent, diarizations, holdChunk } = harness();
  api.beginLocalSession();
  const gate = holdChunk("said just before stop");

  void api.timerTick();
  const stopping = api.stop("session-1");
  await settle();

  assert.deepEqual(events, [], "stop must not capture while the pass is in flight");

  gate.resolve();
  const result = await stopping;

  assert.deepEqual(events, ["chunk-done:system", "flush", "capture", "reset"]);
  assert.equal(result.success, true);
  assert.equal(result.transcript, "said just before stop");
  assert.deepEqual(plain(diarizations[0][3].map((segment) => segment.text)), [
    "said just before stop",
  ]);
  assert.equal(sent.length, 1, "the final is sent before the reset clears the window");
  assert.deepEqual(plain(api.segments), [], "nothing is left for the next session");
});

test("stop still transcribes what was buffered after the in-flight pass", async () => {
  const { api, events, holdChunk } = harness();
  api.beginLocalSession();
  const inFlight = holdChunk("timer pass");

  void api.timerTick();
  const stopping = api.stop("session-1");
  await settle();
  // The final pass, queued behind the in-flight one.
  const finalPass = holdChunk("final pass");
  inFlight.resolve();
  await settle();
  finalPass.resolve();
  const result = await stopping;

  assert.deepEqual(events, ["chunk-done:system", "chunk-done:system", "flush", "capture", "reset"]);
  assert.equal(result.transcript, "timer pass final pass");
});

test("rollback lets late finals land before it resets the session", async () => {
  const { api, events, holdChunk, lateStreamingFinals } = harness();
  api.beginLocalSession();
  const gate = holdChunk("local final");
  lateStreamingFinals.push("streaming final");

  void api.timerTick();
  const rollingBack = api.rollback();
  await settle();
  gate.resolve();
  await rollingBack;

  assert.deepEqual(events, ["chunk-done:system", "disconnect", "reset"]);
  assert.deepEqual(plain(api.segments), []);
});

test("a new session starts with no segments from an earlier one", async () => {
  const { api } = harness();
  api.segments = [{ text: "stale final", source: "mic", timestamp: 1 }];

  const result = await api.start({ provider: "local", sessionId: "session-2" });

  assert.equal(result.success, true);
  assert.deepEqual(plain(api.segments), []);
});

test("start sets the mic alignment strategy from the plan, then from the start result", async () => {
  const { api, events } = harness({
    plannedSystemAudio: { mode: "loopback", strategy: "wasapi-loopback" },
    startedStrategy: "loopback",
  });

  const result = await api.start({ provider: "local", sessionId: "session-1" });

  assert.equal(result.success, true);
  assert.deepEqual(
    events.filter((event) => event.startsWith("strategy:")),
    ["strategy:wasapi-loopback", "strategy:loopback"]
  );
});

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { isLocalModelPolicyRefusal } = require("../../src/helpers/localModelPolicyGate");
const {
  fragmentFilterLanguages,
  isWrongScriptFragment,
} = require("../../src/helpers/meetingFragmentFilter");
const { localBufferEntry, describeLocalChunk } = require("../../src/helpers/meetingLocalChunk");
const { makeSine, toInt16Buffer } = require("./harness/pcmFixtures");

const source = fs.readFileSync(path.join(__dirname, "../../src/helpers/ipcHandlers.js"), "utf8");

const sliceBetween = (startMarker, endMarker) => {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  assert.ok(start >= 0 && end > start, `${startMarker} not found in ipcHandlers.js`);
  return source.slice(start, end);
};

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
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
    _audioFeaturePolicy: { failure: () => null, activeFailure: () => null },
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
    getEnterpriseAudioRequest: async () => null,
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
    ${sliceBetween("const assertMeetingAllowed =", "const fetchRealtimeToken =")}
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

  return {
    api: context.api,
    context,
    policy: context._audioFeaturePolicy,
    events,
    sent,
    diarizations,
    holdChunk,
    lateStreamingFinals,
  };
}

test("policy revocation during system decode prevents the microphone decode from starting", async () => {
  const { api, policy, events, holdChunk } = harness();
  api.beginLocalSession();
  const system = holdChunk("system audio");
  const mic = holdChunk("microphone audio", "mic");
  mic.resolve();

  const pending = api.timerTick();
  policy.activeFailure = () => ({ code: "POLICY_MEETING_RECORDING_DISABLED" });
  system.resolve();
  await pending;

  assert.deepEqual(events, ["chunk-done:system"]);
});

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

// Runs the real local chunk decode over a stubbed engine whose result the
// test releases, to see what reaches the meeting window afterwards.
function chunkHarness({ entries = [localBufferEntry(Buffer.alloc(4), { capturedAt: 0 })] } = {}) {
  const decode = deferred();
  const finals = [];
  const finalSegments = [];
  const suppressionWindows = [];
  const context = {
    _audioFeaturePolicy: { activeFailure: () => null },
    parakeetManager: { transcribeLocalParakeet: () => decode.promise },
    finals,
    finalSegments,
    suppressionWindows,
    entries,
    describeLocalChunk,
    debugLogger: { debug() {}, error() {} },
    Buffer,
    isLocalModelPolicyRefusal: (error) => error?.code?.startsWith("POLICY_"),
    fragmentFilterLanguages,
    isWrongScriptFragment,
  };
  vm.createContext(context);
  vm.runInContext(
    `
    const meetingConnectionOptions = { language: "en" };
    const meetingLocalBuffers = { mic: [], system: [] };
    const meetingLocalWin = { isDestroyed: () => false, webContents: { send: (channel, payload) => finals.push({ channel, payload }) } };
    const meetingLocalProvider = "nvidia";
    const meetingLocalModel = "parakeet";
    const meetingLocalLanguage = "en";
    const LOCAL_MEETING_CHUNK_INTERVAL_MS = 5000;
    const meetingEchoLeakDetector = { isSystemSpeaking: () => false };
    const downsample24kTo16k = (pcm) => pcm;
    const computeChunkStats = () => ({ rms: 1, peak: 1, sampleCount: 2 });
    const resolveMicChunkAction = () => ({ action: "send" });
    const pcm16ToWav = (pcm) => pcm;
    const assertMeetingAllowed = () => {
      if (this._activeLocalMeetingLease) this._localModelPolicy.assertCurrent(this._activeLocalMeetingLease);
    };
    const isSherpaLocalProvider = () => true;
    const removePendingMicFinalsFor = () => [];
    const removeRacingMicEntriesFor = () => [];
    const hasRiskyMicDuplicateProfile = () => false;
    const sendMeetingFinalSegment = (segment) => {
      finals.push(segment.text);
      finalSegments.push(segment);
    };
    const shouldSuppressMicTranscriptSegment = (startAt, endAt) => {
      suppressionWindows.push([startAt, endAt]);
      return { suppress: false };
    };
    const shouldSkipDuplicateMicSegment = () => false;

    ${sliceBetween("const transcribeLocalMeetingChunk =", "const transcribeAllLocalBuffers =")}

    globalThis.transcribe = (source = "system") => {
      meetingLocalBuffers[source] = entries;
      return transcribeLocalMeetingChunk(source);
    };
    `,
    context
  );
  return { context, decode, finals, finalSegments, suppressionWindows };
}

const T = 1_700_000_000_000;
const silence = (durationMs) => new Float32Array(Math.round((durationMs / 1000) * 24000));
const tone = (durationMs) => makeSine({ durationMs, amplitude: 0.5 });
const concatTracks = (...tracks) => {
  const out = new Float32Array(tracks.reduce((sum, track) => sum + track.length, 0));
  let offset = 0;
  for (const track of tracks) {
    out.set(track, offset);
    offset += track.length;
  }
  return out;
};

test("a local row is stamped with its audio's range, not the decode time", async () => {
  const buffer = toInt16Buffer(concatTracks(silence(2000), tone(1000), silence(2000)));
  const { context, decode, finalSegments } = chunkHarness({
    entries: [localBufferEntry(buffer, { capturedAt: T })],
  });
  const pending = context.transcribe("system");
  await new Promise((resolve) => setTimeout(resolve, 50)); // decode time must not move the stamp
  decode.resolve({ success: true, text: "hello there" });
  await pending;
  assert.equal(finalSegments[0].timestamp, T + 2000);
  assert.equal(finalSegments[0].endTimestamp, T + 3000);
  assert.equal(finalSegments[0].timestampIsSpeechStart, undefined);
});

test("the mic echo check looks at the chunk's capture window", async () => {
  const buffer = toInt16Buffer(tone(5000));
  const { context, decode, suppressionWindows } = chunkHarness({
    entries: [localBufferEntry(buffer, { capturedAt: T })],
  });
  const pending = context.transcribe("mic");
  decode.resolve({ success: true, text: "my own words" });
  await pending;
  assert.deepEqual(plain(suppressionWindows), [[T, T + 5000]]);
});

test("local meeting admission authorizes its selected model before capturing or loading", async () => {
  const { api, context, events } = harness();
  context._localModelPolicy = {
    authorize: async () => {
      throw Object.assign(new Error("blocked"), { code: "POLICY_MODEL_BLOCKED" });
    },
  };
  const result = await api.start({ provider: "local", localModel: "base", sessionId: "blocked" });
  assert.equal(result.success, false);
  assert.equal(
    events.some((event) => event.startsWith("strategy:")),
    false
  );
});

test("a typed local chunk refusal stops the meeting and sends its code", async () => {
  const { context, decode, finals } = chunkHarness();
  const stopped = [];
  context.isLocalModelPolicyRefusal = (error) => error?.code === "POLICY_MODEL_BLOCKED";
  context._stopMeetingForPolicy = (code) => stopped.push(code);
  const pending = context.transcribe();
  decode.reject(Object.assign(new Error("blocked"), { code: "POLICY_MODEL_BLOCKED" }));
  await pending;
  assert.deepEqual(stopped, ["POLICY_MODEL_BLOCKED"]);
  assert.deepEqual(plain(finals), [
    { channel: "meeting-transcription-error", payload: "POLICY_MODEL_BLOCKED" },
  ]);
});

test("a chunk cut off by the meeting's revocation adds nothing raw after the stop's own reason", async () => {
  const { context, decode, finals } = chunkHarness();
  context._activeLocalMeetingLease = { signal: { aborted: false } };
  context._localModelPolicy = { assertCurrent() {}, runWithLease: (_lease, run) => run() };
  const pending = context.transcribe();
  context._activeLocalMeetingLease.signal.aborted = true;
  decode.reject(new Error("whisper-server request cancelled"));
  await pending;
  assert.deepEqual(plain(finals), []);
});

test("a local meeting lease invalidated during admission is released before returning", async () => {
  const { api, context } = harness();
  let released = 0;
  context._localModelPolicy = {
    authorize: async () => ({ modelId: "base" }),
    assertCurrent: () => {
      throw Object.assign(new Error("account changed"), { code: "POLICY_UNRESOLVABLE" });
    },
    release: () => {
      released++;
    },
  };
  assert.equal(
    (await api.start({ provider: "local", localModel: "base", sessionId: "invalid" })).success,
    false
  );
  assert.equal(released, 1);
  assert.equal(context._activeLocalMeetingLease, null);
});

test("model policy refresh stops only the active local meeting selection before its first native load", () => {
  const callback = sliceBetween("onChange: () => {", "    for (const manager of [");
  for (const activeModel of [null, "base"]) {
    const stopped = [];
    const context = {
      localServers: activeModel
        ? []
        : [["transcription", { stop: async () => {}, isRemote: false }, () => "small"]],
      _activeLocalMeetingLease: activeModel ? { modelId: activeModel } : null,
      _localModelPolicy: {
        failure: () => ({ code: "POLICY_MODEL_BLOCKED" }),
        assertCurrent: () => {
          throw Object.assign(new Error("blocked"), { code: "POLICY_MODEL_BLOCKED" });
        },
      },
      _stopMeetingForPolicy: (code) => stopped.push(code),
      debugLogger: { warn() {} },
      isLocalModelPolicyRefusal,
    };
    vm.createContext(context);
    vm.runInContext(
      `const config = capture({ ${callback}`,
      Object.assign(context, { capture: (value) => value })
    );
    vm.runInContext("config.onChange()", context);
    assert.deepEqual(stopped, activeModel ? ["POLICY_MODEL_BLOCKED"] : []);
  }
});

test("a local decode that finishes after revocation delivers no text", async () => {
  for (const revoked of [false, true]) {
    const { context, decode, finals } = chunkHarness();
    const pending = context.transcribe();
    if (revoked) {
      context._audioFeaturePolicy.activeFailure = () => ({
        code: "POLICY_MEETING_RECORDING_DISABLED",
      });
    }
    decode.resolve({ success: true, text: "said as the policy changed" });
    await pending;
    assert.deepEqual(plain(finals), revoked ? [] : ["said as the policy changed"]);
  }
});

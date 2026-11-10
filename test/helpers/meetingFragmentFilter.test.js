const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const OpenAIRealtimeStreaming = require("../../src/helpers/openaiRealtimeStreaming");
const {
  createRendererServer,
  installBrowserGlobals,
  installMicCaptureGlobals,
} = require("../lib/rendererTestHarness");

const {
  fragmentFilterLanguages,
  isWrongScriptFragment,
} = require("../../src/helpers/meetingFragmentFilter");

test("a short fragment in a script the meeting language doesn't use is dropped", () => {
  for (const fragment of ["어.", "Да.", "うん。", "是啊。", "음."]) {
    assert.equal(isWrongScriptFragment(fragment, ["en"]), true, fragment);
  }
});

test("a fragment in the meeting language's own script is kept", () => {
  assert.equal(isWrongScriptFragment("Да.", ["ru"]), false);
  assert.equal(isWrongScriptFragment("うん。", ["ja"]), false);
  assert.equal(isWrongScriptFragment("是啊。", ["zh"]), false);
  assert.equal(isWrongScriptFragment("네.", ["ko"]), false);
});

test("Japanese responses with a shared-script vowel mark are kept only in an expected script", () => {
  for (const text of ["えー。", "はーい", "ノー。", "オーケー"]) {
    assert.equal(isWrongScriptFragment(text, ["ja"]), false, text);
    assert.equal(isWrongScriptFragment(text, ["en"]), true, text);
  }
});

test("Latin text is never treated as a wrong script", () => {
  assert.equal(isWrongScriptFragment("Ja.", ["en"]), false);
  assert.equal(isWrongScriptFragment("OK", ["ja"]), false);
});

test("rows longer than four characters are kept whatever their script", () => {
  assert.equal(isWrongScriptFragment("어어어.", ["en"]), true);
  assert.equal(isWrongScriptFragment("어어어어.", ["en"]), false);
  assert.equal(isWrongScriptFragment("Это длинная фраза", ["en"]), false);
});

test("rows without letters are kept", () => {
  assert.equal(isWrongScriptFragment("…", ["en"]), false);
  assert.equal(isWrongScriptFragment("1.", ["en"]), false);
});

test("any of the user's languages makes its script expected", () => {
  assert.equal(isWrongScriptFragment("Да.", ["en", "ru"]), false);
  assert.equal(isWrongScriptFragment("어.", ["en", "ru"]), true);
});

test("region codes count as their base language", () => {
  assert.equal(isWrongScriptFragment("어.", ["en-GB"]), true);
  assert.equal(isWrongScriptFragment("是啊。", ["zh-TW"]), false);
});

test("nothing is dropped when the expected languages aren't known", () => {
  assert.equal(isWrongScriptFragment("어.", []), false);
  assert.equal(isWrongScriptFragment("어.", ["xx"]), false);
  assert.equal(isWrongScriptFragment("어.", ["en", "xx"]), false);
});

test("the meeting language wins, and spoken languages stand in for auto", () => {
  assert.deepEqual(fragmentFilterLanguages({ language: "en", spokenLanguages: ["ru"] }), ["en"]);
  assert.deepEqual(fragmentFilterLanguages({ spokenLanguages: ["en", "ru"] }), ["en", "ru"]);
  assert.deepEqual(fragmentFilterLanguages({ language: "auto", spokenLanguages: ["de"] }), ["de"]);
  assert.deepEqual(fragmentFilterLanguages({}), []);
  assert.deepEqual(fragmentFilterLanguages(null), []);
});

// Runs the real streaming final handler from ipcHandlers.js with its
// collaborators stubbed, so the wiring is tested and not just the helper.
const source = fs.readFileSync(path.join(__dirname, "../../src/helpers/ipcHandlers.js"), "utf8");
const sliceBetween = (startMarker, endMarker) => {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  assert.ok(start >= 0 && end > start, `${startMarker} not found in ipcHandlers.js`);
  return source.slice(start, end);
};

function streamingHarness({ language, spokenLanguages, onSegment = () => {} }) {
  const accepted = [];
  const streams = { mic: new OpenAIRealtimeStreaming(), system: new OpenAIRealtimeStreaming() };
  const win = {
    isDestroyed: () => false,
    webContents: {
      send: (channel, payload) => {
        if (channel === "meeting-transcription-segment") onSegment(payload);
      },
    },
  };
  const noSuppression = { suppress: false, reason: null };
  const context = {
    _meetingMicStreaming: streams.mic,
    _meetingSystemStreaming: streams.system,
    windowManager: { controlPanelWindow: win },
    _startOrSkipDiarization() {},
    meetingDiarizationSegments: accepted,
    meetingConnectionOptions: { language, spokenLanguages },
    fragmentFilterLanguages,
    isWrongScriptFragment,
    debugLogger: { debug() {} },
    meetingEchoLeakDetector: { isMicProbablyRenderBleed: () => false },
    shouldSuppressMicTranscriptSegment: () => noSuppression,
    shouldSkipDuplicateMicSegment: () => false,
    hasRiskyMicDuplicateProfile: () => false,
    removePendingMicFinalsFor: () => [],
    removeRacingMicEntriesFor: () => [],
    clearMeetingSystemAudioSilenceTimer() {},
    stopMeetingSystemAudioWatchdog() {},
    flushPendingMeetingMicChunks() {},
    stopMeetingAec: async () => {},
    stopLiveSpeakerIdentification: async () => null,
    meetingLocalWin: null,
    meetingLocalMode: false,
    meetingNoteId: 11,
    meetingSpeakerIndexBase: 0,
    flushPendingMicFinals() {},
    resetMeetingStreamingState() {},
    captureMeetingDiarizationState: async () => ({ diarizationSegments: accepted }),
  };
  vm.createContext(context);
  vm.runInContext(
    `${sliceBetween("const appendMeetingLocalTranscript = ", "function flushPendingMicFinals(")}
    ${sliceBetween(
      "const attachMeetingStreamingHandlers = ",
      "const resetMeetingReconnectAudio = "
    )}
    ${sliceBetween("const disconnectMeetingStreaming = ", "const clearMeetingSystemAudioSilenceTimer = ")}
    ${sliceBetween("const stopMeetingTranscription = ", "const meetingTranscriptionLifecycle = ")}
    this.attach = attachMeetingStreamingHandlers;
    this.stop = stopMeetingTranscription;`,
    context
  );
  for (const [source, streaming] of Object.entries(streams)) context.attach(streaming, win, source);
  let turn = 0;
  const finish = (source, text) => {
    const streaming = streams[source];
    streaming.handleMessage(
      JSON.stringify({
        type: "conversation.item.input_audio_transcription.delta",
        delta: text,
      })
    );
    streaming.handleMessage(
      JSON.stringify({
        type: "conversation.item.input_audio_transcription.completed",
        item_id: `turn-${turn++}`,
        transcript: text,
      })
    );
  };
  return {
    get finals() {
      return accepted.map((segment) => segment.text);
    },
    finish,
    finishOnStop(source, text) {
      const streaming = streams[source];
      streaming.audioBytesSent = 1;
      streaming.ws = {
        readyState: 1,
        send(message) {
          assert.equal(JSON.parse(message).type, "input_audio_buffer.commit");
          queueMicrotask(() => finish(source, text));
        },
        close() {},
      };
    },
    stop: () => context.stop(),
  };
}

test("a streamed fragment in the meeting's own script is kept", () => {
  const run = streamingHarness({ language: "ko" });
  run.finish("system", "네.");
  assert.deepEqual(run.finals, ["네."]);
});

async function recordingHarness(t, { language = "en", spokenLanguages } = {}) {
  const writes = [];
  let segmentListener;
  let store;
  t.after(() => store?.stopRecording());
  const streaming = streamingHarness({
    language,
    spokenLanguages,
    onSegment: (segment) => segmentListener?.(segment),
  });
  const noopListener = () => () => {};
  installMicCaptureGlobals(t);
  installBrowserGlobals(t, {
    window: {
      electronAPI: {
        checkSystemAudioAccess: async () => ({
          granted: true,
          status: "granted",
          mode: "native",
          strategy: "native",
        }),
        meetingTranscriptionStart: async () => ({
          success: true,
          systemAudioMode: "native",
          systemAudioStrategy: "native",
        }),
        meetingTranscriptionSetSystemAudioAvailable: async () => ({ success: true }),
        meetingTranscriptionStop: streaming.stop,
        meetingTranscriptionSend() {},
        getNote: async () => ({ id: 11, transcript: "", deleted_at: null }),
        updateNote: async (id, patch) => {
          writes.push({ id, patch });
          return { success: true };
        },
        onMeetingTranscriptionSegment: (callback) => {
          segmentListener = callback;
          return () => {
            segmentListener = null;
          };
        },
        onMeetingSpeakerIdentified: noopListener,
        onMeetingSpeakersMerged: noopListener,
        onMeetingSessionSpeakerConfigUpdated: noopListener,
        onMeetingTranscriptionError: noopListener,
        onMeetingTranscriptionFatalError: noopListener,
        onMeetingSystemAudioSilent: noopListener,
        onMeetingDiarizationComplete: noopListener,
      },
    },
  });
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-meeting-fragment-stop-test-",
  });
  store = await vite.ssrLoadModule("/stores/meetingRecordingStore.ts");
  assert.equal(
    await store.startRecording({ noteId: 11, noteTitle: "Meeting", folderId: null }),
    true
  );
  return { streaming, store, writes };
}

for (const source of ["mic", "system"]) {
  test(`rejected-only ${source} fragments stay absent after stop and never reach note persistence`, async (t) => {
    const { streaming, store, writes } = await recordingHarness(t);
    streaming.finish(source, "어.");
    streaming.finish(source, "Да.");
    assert.equal(store.useMeetingRecordingStore.getState().transcript, "");
    assert.equal(store.useMeetingRecordingStore.getState()[`${source}Partial`], "");

    await store.stopRecording();

    assert.equal(store.useMeetingRecordingStore.getState().transcript, "");
    assert.deepEqual(store.useMeetingRecordingStore.getState().segments, []);
    assert.deepEqual(writes, []);
  });
}

test("valid speech finalized during disconnect still reaches the saved note", async (t) => {
  const { streaming, store, writes } = await recordingHarness(t);
  streaming.finishOnStop("mic", "One last thing.");
  await store.stopRecording();
  assert.equal(store.useMeetingRecordingStore.getState().transcript, "One last thing.");
  assert.equal(writes.at(-1).patch.transcript, "One last thing.");
});

test("a wrong-script final arriving during disconnect is not saved", async (t) => {
  const { streaming, store, writes } = await recordingHarness(t, {
    language: "auto",
    spokenLanguages: ["en"],
  });
  streaming.finishOnStop("system", "어.");
  await store.stopRecording();
  assert.equal(store.useMeetingRecordingStore.getState().transcript, "");
  assert.deepEqual(writes, []);
});

// Runs the real local chunk transcriber with a stubbed engine returning `text`.
function localHarness({ language, text }) {
  const finals = [];
  const context = {
    self: {
      _audioFeaturePolicy: { activeFailure: () => null },
      _resolveWhisperVadOptions: () => ({}),
      whisperManager: { transcribeLocalWhisper: async () => ({ success: true, text }) },
    },
    meetingConnectionOptions: { language },
    fragmentFilterLanguages,
    isWrongScriptFragment,
    Buffer,
    meetingLocalBuffers: { mic: [Buffer.alloc(4800)], system: [Buffer.alloc(4800)] },
    meetingLocalProvider: "whisper",
    meetingLocalModel: "base",
    meetingLocalLanguage: language,
    downsample24kTo16k: (pcm) => pcm,
    computeChunkStats: () => ({ rms: 0.1, peak: 0.5, sampleCount: 1600 }),
    resolveMicChunkAction: () => ({ action: "send", reason: null }),
    pcm16ToWav: (pcm) => pcm,
    isSherpaLocalProvider: () => false,
    assertMeetingAllowed: () => {},
    debugLogger: { debug() {} },
    removePendingMicFinalsFor: () => [],
    removeRacingMicEntriesFor: () => [],
    sendMeetingFinalSegment: (segment) => finals.push(segment.text),
  };
  vm.createContext(context);
  vm.runInContext(
    `(function () {
      ${sliceBetween("const transcribeLocalMeetingChunk = ", "const transcribeAllLocalBuffers =")}
      this.transcribe = transcribeLocalMeetingChunk;
    }).call(self);`,
    context
  );
  return { finals, transcribe: (source) => context.self.transcribe(source) };
}

test("a locally transcribed wrong-script fragment never reaches the transcript", async () => {
  for (const source of ["mic", "system"]) {
    const run = localHarness({ language: "en", text: " 어. " });
    await run.transcribe(source);
    assert.deepEqual(run.finals, [], source);
  }
});

test("a locally transcribed row in an expected script is kept", async () => {
  const run = localHarness({ language: "en", text: "Okay." });
  await run.transcribe("system");
  assert.deepEqual(run.finals, ["Okay."]);
});

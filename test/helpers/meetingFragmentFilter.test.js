const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

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

// Objects made inside the vm context have another realm's prototype.
const plain = (value) => JSON.parse(JSON.stringify(value));

function streamingHarness({ language }) {
  const sent = [];
  const finals = [];
  const win = {
    isDestroyed: () => false,
    webContents: { send: (channel, payload) => sent.push({ channel, payload }) },
  };
  const noSuppression = { suppress: false, reason: null };
  const context = {
    win,
    finals,
    meetingConnectionOptions: { language },
    fragmentFilterLanguages,
    isWrongScriptFragment,
    debugLogger: { debug() {}, error() {}, warn() {}, info() {} },
    meetingEchoLeakDetector: { isMicProbablyRenderBleed: () => false },
    shouldSuppressMicTranscriptSegment: () => noSuppression,
    shouldSkipDuplicateMicSegment: () => false,
    hasRiskyMicDuplicateProfile: () => false,
    removePendingMicFinalsFor: () => [],
    removeRacingMicEntriesFor: () => [],
    queuePendingMicFinal: () => assert.fail("nothing should be held back"),
    sendMeetingFinalSegment: (segment) => finals.push(segment.text),
    reconnectMeetingStreams: async () => true,
    meetingFatalErrorSent: false,
  };
  vm.createContext(context);
  vm.runInContext(
    `${sliceBetween(
      "const attachMeetingStreamingHandlers = ",
      "const resetMeetingReconnectAudio = "
    )}
    this.attach = attachMeetingStreamingHandlers;`,
    context
  );
  return {
    sent,
    finals,
    finish(source, text) {
      const streaming = { completedSegments: [text] };
      context.attach(streaming, win, source);
      streaming.onFinalTranscript(text, 1000);
    },
  };
}

test("a streamed wrong-script fragment never reaches the transcript and clears its live text", () => {
  for (const source of ["mic", "system"]) {
    const run = streamingHarness({ language: "en" });
    run.finish(source, "어.");
    assert.deepEqual(run.finals, [], source);
    assert.deepEqual(
      run.sent.map((s) => plain(s.payload)),
      [{ text: "", source, type: "partial" }],
      source
    );
  }
});

test("a streamed fragment in the meeting's own script is kept", () => {
  const run = streamingHarness({ language: "ko" });
  run.finish("system", "네.");
  assert.deepEqual(run.finals, ["네."]);
});

// Runs the real local chunk transcriber with a stubbed engine returning `text`.
function localHarness({ language, text }) {
  const finals = [];
  const context = {
    finals,
    self: {
      _activeLocalMeetingLease: null,
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
    meetingLocalWin: null,
    LOCAL_MEETING_CHUNK_INTERVAL_MS: 5000,
    LOCAL_RISKY_MIC_SEGMENT_HOLDBACK_MS: 0,
    downsample24kTo16k: (pcm) => pcm,
    computeChunkStats: () => ({ rms: 0.1, peak: 0.5, sampleCount: 1600 }),
    resolveMicChunkAction: () => ({ action: "send", reason: null }),
    meetingEchoLeakDetector: { isSystemSpeaking: () => false },
    pcm16ToWav: (pcm) => pcm,
    isSherpaLocalProvider: () => false,
    assertMeetingAllowed: () => {},
    isLocalModelPolicyRefusal: () => false,
    debugLogger: { debug() {}, error() {}, warn() {}, info() {} },
    shouldSuppressMicTranscriptSegment: () => ({ suppress: false, reason: null }),
    shouldSkipDuplicateMicSegment: () => false,
    hasRiskyMicDuplicateProfile: () => false,
    removePendingMicFinalsFor: () => [],
    removeRacingMicEntriesFor: () => [],
    queuePendingMicFinal: () => assert.fail("nothing should be held back"),
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

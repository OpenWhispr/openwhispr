const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

// mergeWithTranscript is pure, but diarization.js pulls in helpers that reach
// for electron at load time. Stub the pieces they touch so the merge rules can
// be exercised outside Electron.
require.cache[require.resolve("electron")] = {
  exports: {
    app: {
      getPath: () => "/tmp",
      getAppPath: () => process.cwd(),
      isPackaged: false,
    },
    net: {},
  },
};

const DiarizationManager = require("../../src/helpers/diarization.js");
const DeepgramStreaming = require("../../src/helpers/deepgramStreaming.js");

const systemSegment = (timestamp, text) => ({ source: "system", timestamp, text });
const micSegment = (timestamp, text) => ({ source: "mic", timestamp, text });

test("a segment between clusters takes the nearest cluster, not the first", () => {
  const manager = new DiarizationManager();

  // Midpoint 51.25s: 46.25s past speaker_0, 8.75s before speaker_1.
  const merged = manager.mergeWithTranscript(
    [systemSegment(50, "so where did we land on pricing")],
    [
      { start: 0, end: 5, speaker: "speaker_0" },
      { start: 60, end: 70, speaker: "speaker_1" },
    ]
  );

  assert.equal(merged[0].speaker, "speaker_1");
});

test("a row followed by a pause keeps its own speaker, not the busier one after it", () => {
  const manager = new DiarizationManager();

  // Five words take about 2 s; the next row only arrives at 30 s.
  const merged = manager.mergeWithTranscript(
    [systemSegment(10, "yes I agree with that"), systemSegment(30, "so as I was saying")],
    [
      { start: 10, end: 12.5, speaker: "speaker_0" },
      { start: 12.5, end: 34, speaker: "speaker_1" },
    ]
  );

  assert.equal(merged[0].speaker, "speaker_0");
  assert.equal(merged[1].speaker, "speaker_1");
});

test("a row written without spaces is measured by its words", () => {
  const manager = new DiarizationManager();

  // About 11 words, so about 4 s of speech, not a single space-separated word.
  const merged = manager.mergeWithTranscript(
    [systemSegment(10, "我们下周三下午再来讨论这个预算问题吧"), systemSegment(30, "好的")],
    [
      { start: 8, end: 10.8, speaker: "speaker_0" },
      { start: 10.8, end: 14.5, speaker: "speaker_1" },
      { start: 14.5, end: 30, speaker: "speaker_2" },
    ]
  );

  assert.equal(merged[0].speaker, "speaker_1");
});

test("a last row stamped just before the recording starts still covers its words", () => {
  const manager = new DiarizationManager();

  const merged = manager.mergeWithTranscript(
    [systemSegment(-0.5, "hello there everyone how are you")],
    [
      { start: -2, end: -0.4, speaker: "speaker_0" },
      { start: 0.2, end: 3, speaker: "speaker_1" },
    ]
  );

  assert.equal(merged[0].speaker, "speaker_1");
});

test("a segment past the last cluster belongs to that cluster", () => {
  const manager = new DiarizationManager();

  const merged = manager.mergeWithTranscript(
    [systemSegment(100, "one last thing before we wrap")],
    [
      { start: 0, end: 5, speaker: "speaker_0" },
      { start: 60, end: 70, speaker: "speaker_1" },
    ]
  );

  assert.equal(merged[0].speaker, "speaker_1");
});

test("the largest overlapping cluster still wins over the nearest one", () => {
  const manager = new DiarizationManager();

  // The segment spans 50s–52.5s. speaker_0 overlaps 0.5s and starts exactly at
  // the segment, so it is both the first cluster and a zero-distance match;
  // speaker_1 overlaps 2s and must win on overlap.
  const merged = manager.mergeWithTranscript(
    [systemSegment(50, "that matches what I saw")],
    [
      { start: 50, end: 50.5, speaker: "speaker_0" },
      { start: 50.5, end: 53, speaker: "speaker_1" },
    ]
  );

  assert.equal(merged[0].speaker, "speaker_1");
});

test("mic segments stay owned by you and survive an empty diarization run", () => {
  const manager = new DiarizationManager();

  const withClusters = manager.mergeWithTranscript(
    [{ source: "mic", timestamp: 1, text: "morning" }],
    [{ start: 0, end: 5, speaker: "speaker_0" }]
  );
  assert.equal(withClusters[0].speaker, "you");

  const withoutClusters = manager.mergeWithTranscript([systemSegment(1, "morning")], []);
  assert.equal(withoutClusters[0].speaker, undefined);
});

test("mic segments stay owned by you under an explicit system diarizedSource", () => {
  const manager = new DiarizationManager();

  const merged = manager.mergeWithTranscript(
    [micSegment(1, "morning")],
    [{ start: 0, end: 5, speaker: "speaker_0" }],
    { diarizedSource: "system" }
  );

  assert.equal(merged[0].speaker, "you");
});

test("mic mode assigns mic segments to clusters by overlap and nearest distance", () => {
  const manager = new DiarizationManager();

  const merged = manager.mergeWithTranscript(
    [
      micSegment(1, "so what did everyone think of the draft"),
      // Midpoint 51.25s: 46.25s past speaker_00, 8.75s before speaker_01.
      micSegment(50, "honestly the second section needs work"),
    ],
    [
      { start: 0, end: 5, speaker: "speaker_00" },
      { start: 60, end: 70, speaker: "speaker_01" },
    ],
    { diarizedSource: "mic" }
  );

  assert.equal(merged[0].speaker, "speaker_0");
  assert.equal(merged[1].speaker, "speaker_1");
});

test("mic mode with a single cluster keeps the mic track as you", () => {
  // A call where the remote party never speaks audibly diarizes the mic track;
  // its lone cluster is the user, not a stranger named speaker_0.
  const manager = new DiarizationManager();

  const merged = manager.mergeWithTranscript(
    [micSegment(1, "hello can you hear me"), micSegment(30, "okay I will follow up by email")],
    [{ start: 0, end: 40, speaker: "speaker_00" }],
    { diarizedSource: "mic" }
  );

  assert.equal(merged[0].speaker, "you");
  assert.equal(merged[1].speaker, "you");
});

test("mic mode leaves system segments unlabeled", () => {
  const manager = new DiarizationManager();

  const merged = manager.mergeWithTranscript(
    [systemSegment(1, "notification ding"), micSegment(2, "as I was saying")],
    [
      { start: 0, end: 5, speaker: "speaker_00" },
      { start: 10, end: 20, speaker: "speaker_01" },
    ],
    { diarizedSource: "mic" }
  );

  assert.equal(merged[0].speaker, undefined);
  assert.equal(merged[1].speaker, "speaker_0");
});

test("mic mode still dedupes bleed-flagged mic echoes of system text first", () => {
  const manager = new DiarizationManager();

  const { kept } = manager.splitMicEchoDuplicates([
    systemSegment(10, "the quarterly revenue forecast slipped again"),
    {
      ...micSegment(10.5, "the quarterly revenue forecast slipped again"),
      likelyRenderBleed: true,
    },
  ]);
  const merged = manager.mergeWithTranscript(
    kept,
    [
      { start: 0, end: 5, speaker: "speaker_00" },
      { start: 10, end: 20, speaker: "speaker_01" },
    ],
    { diarizedSource: "mic" }
  );

  assert.equal(merged.length, 1);
  assert.equal(merged[0].source, "system");
});

test("a resumed session's clusters are numbered from its speaker index base", () => {
  const manager = new DiarizationManager();

  const merged = manager.mergeWithTranscript(
    [systemSegment(1, "picking this back up"), systemSegment(11, "sounds good")],
    [
      { start: 0, end: 5, speaker: "speaker_00" },
      { start: 10, end: 15, speaker: "speaker_01" },
    ],
    { speakerIndexBase: 3 }
  );

  assert.deepEqual(
    merged.map((segment) => segment.speaker),
    ["speaker_3", "speaker_4"]
  );
});

const MEETING_START_MS = 1800000000000;
const ipcSource = fs.readFileSync(path.join(__dirname, "../../src/helpers/ipcHandlers.js"), "utf8");
const meetingSection = (startMarker, endMarker) => {
  const start = ipcSource.indexOf(startMarker);
  const end = ipcSource.indexOf(endMarker, start);
  assert.ok(start >= 0 && end > start, `${startMarker} not found in ipcHandlers.js`);
  return ipcSource.slice(start, end);
};

// Run the real producer, final sender and storage closure. Only inference,
// audio conversion and holdback timers are replaced; held emitters stay real.
function meetingRowsHarness({ holdMic = false } = {}) {
  const segments = [];
  const sent = [];
  const pending = [];
  let now = MEETING_START_MS;
  let decodedText = "";
  const win = {
    isDestroyed: () => false,
    webContents: { send: (channel, payload) => sent.push({ channel, payload }) },
  };
  const context = {
    Buffer,
    DeepgramStreaming,
    Date: { now: () => now },
    meetingDiarizationSegments: segments,
    meetingLocalTranscript: "",
    meetingLocalMode: false,
    meetingLocalBuffers: { mic: [], system: [] },
    meetingLocalWin: win,
    meetingLocalProvider: "nvidia",
    meetingLocalModel: "parakeet",
    meetingLocalLanguage: "en",
    LOCAL_MEETING_CHUNK_INTERVAL_MS: 5000,
    LOCAL_RISKY_MIC_SEGMENT_HOLDBACK_MS: 6000,
    STREAMING_RISKY_MIC_SEGMENT_HOLDBACK_MS: 3000,
    _audioFeaturePolicy: { activeFailure: () => null },
    parakeetManager: {
      transcribeLocalParakeet: async () => ({ success: true, text: decodedText }),
    },
    downsample24kTo16k: (buffer) => buffer,
    pcm16ToWav: (buffer) => buffer,
    computeChunkStats: () => ({ rms: 0.2, peak: 0.5, sampleCount: 80000 }),
    resolveMicChunkAction: () => ({ action: "send" }),
    isSherpaLocalProvider: () => true,
    isLocalModelPolicyRefusal: () => false,
    assertMeetingAllowed() {},
    debugLogger: { debug() {}, error() {} },
    shouldSuppressMicTranscriptSegment: () => ({ suppress: false }),
    shouldSkipDuplicateMicSegment: () => false,
    hasRiskyMicDuplicateProfile: () => holdMic,
    queuePendingMicFinal: (entry) => pending.push(entry),
    removePendingMicFinalsFor: () => [],
    removeRacingMicEntriesFor: () => [],
  };
  vm.createContext(context);
  vm.runInContext(
    `
    ${meetingSection("const appendMeetingLocalTranscript =", "function flushPendingMicFinals(")}
    ${meetingSection("const transcribeLocalMeetingChunk =", "const transcribeAllLocalBuffers =")}
    ${meetingSection("const attachMeetingStreamingHandlers =", "const resetMeetingReconnectAudio =")}
    globalThis.transcribeLocal = transcribeLocalMeetingChunk;
    globalThis.attachStreaming = attachMeetingStreamingHandlers;
    `,
    context
  );
  return {
    segments,
    sent,
    transcribe: async (source, text, seconds) => {
      context.meetingLocalMode = true;
      now = MEETING_START_MS + seconds * 1000;
      decodedText = text;
      context.meetingLocalBuffers[source] = [Buffer.alloc(24000 * 2 * 5)];
      await context.transcribeLocal(source);
    },
    attach: (streaming, source) => context.attachStreaming(streaming, win, source),
    release: () => {
      now = MEETING_START_MS + 20000;
      for (const entry of pending.splice(0)) entry.emit();
    },
  };
}

const normalizedMeetingRows = (segments) =>
  segments.map((segment) => ({
    ...segment,
    timestamp: (segment.timestamp - MEETING_START_MS) / 1000,
  }));
const rowContents = (segments) =>
  segments.map(({ text, source, timestamp }) => ({ text, source, timestamp }));

for (const source of ["system", "mic"]) {
  const held = source === "mic";
  test(`local ${held ? "held mic" : "system"} rows keep the speaker from their decoded batch`, async () => {
    const harness = meetingRowsHarness({ holdMic: held });
    await harness.transcribe(source, "Good morning.", 5.1);
    await harness.transcribe(source, "Morning. Shall we discuss the budget today?", 10.1);
    if (held) assert.equal(harness.segments.length, 0);
    harness.release();

    const expectedRows = [
      { source, timestamp: 5.1, text: "Good morning." },
      { source, timestamp: 10.1, text: "Morning. Shall we discuss the budget today?" },
    ];
    const rows = normalizedMeetingRows(harness.segments);
    assert.deepEqual(rowContents(rows), expectedRows);
    const sentFinals = harness.sent.filter(({ payload }) => payload.type === "final");
    assert.deepEqual(
      rowContents(normalizedMeetingRows(sentFinals.map(({ payload }) => payload))),
      expectedRows
    );

    // The first batch ends at 5s. The reply belongs to the next batch,
    // although its audio overlaps the first batch's decode-completion time.
    const merged = new DiarizationManager().mergeWithTranscript(
      rows,
      [
        { start: 4, end: 5, speaker: "speaker_0" },
        { start: 5, end: 6.2, speaker: "speaker_1" },
        { start: 6.2, end: 10, speaker: "speaker_0" },
      ],
      { diarizedSource: source }
    );
    assert.deepEqual(rowContents(merged), expectedRows);
    assert.deepEqual(
      merged.map((segment) => segment.speaker),
      ["speaker_0", "speaker_0"]
    );
  });

  test(`Deepgram ${held ? "held mic" : "system"} rows retain speech after leading silence`, () => {
    const harness = meetingRowsHarness({ holdMic: held });
    const streaming = new DeepgramStreaming();
    streaming.sessionStartedAt = MEETING_START_MS;
    harness.attach(streaming, source);
    streaming.handleMessage(
      JSON.stringify({
        type: "Results",
        start: 10,
        duration: 4.6,
        is_final: true,
        speech_final: true,
        channel: {
          alternatives: [{ transcript: "Yes.", words: [{ word: "yes", start: 14, end: 14.5 }] }],
        },
      })
    );
    streaming.handleMessage(
      JSON.stringify({
        type: "Results",
        start: 14.6,
        duration: 3.4,
        is_final: true,
        speech_final: true,
        channel: {
          alternatives: [
            {
              transcript: "Let us get started.",
              words: [
                { word: "let", start: 15, end: 15.2 },
                { word: "us", start: 15.3, end: 15.5 },
                { word: "get", start: 15.6, end: 16 },
                { word: "started", start: 16.1, end: 17 },
              ],
            },
          ],
        },
      })
    );
    if (held) assert.equal(harness.segments.length, 0);
    harness.release();

    const expectedRows = [
      { source, timestamp: 10, text: "Yes." },
      { source, timestamp: 14.6, text: "Let us get started." },
    ];
    const rows = normalizedMeetingRows(harness.segments);
    assert.deepEqual(rowContents(rows), expectedRows);
    const sentFinals = harness.sent.filter(({ payload }) => payload.type === "final");
    assert.deepEqual(
      rowContents(normalizedMeetingRows(sentFinals.map(({ payload }) => payload))),
      expectedRows
    );
    const merged = new DiarizationManager().mergeWithTranscript(
      rows,
      [
        { start: 7, end: 10, speaker: "speaker_0" },
        { start: 14, end: 14.5, speaker: "speaker_1" },
        { start: 15, end: 18, speaker: "speaker_2" },
      ],
      { diarizedSource: source }
    );
    assert.deepEqual(rowContents(merged), expectedRows);
    assert.deepEqual(
      merged.map((segment) => segment.speaker),
      ["speaker_1", "speaker_2"]
    );
  });
}

test("speech-start streaming rows still exclude a later speaker during a pause", () => {
  const harness = meetingRowsHarness();
  const streaming = { completedSegments: [] };
  harness.attach(streaming, "system");
  for (const [seconds, text] of [
    [10, "yes I agree with that"],
    [30, "so as I was saying"],
  ]) {
    streaming.completedSegments.push(text);
    streaming.onFinalTranscript(
      streaming.completedSegments.join(" "),
      MEETING_START_MS + seconds * 1000
    );
  }
  const rows = normalizedMeetingRows(harness.segments);
  assert.deepEqual(rowContents(rows), [
    systemSegment(10, "yes I agree with that"),
    systemSegment(30, "so as I was saying"),
  ]);
  const merged = new DiarizationManager().mergeWithTranscript(rows, [
    { start: 10, end: 12.5, speaker: "speaker_0" },
    { start: 12.5, end: 34, speaker: "speaker_1" },
  ]);
  assert.deepEqual(
    merged.map((segment) => segment.speaker),
    ["speaker_0", "speaker_1"]
  );
});

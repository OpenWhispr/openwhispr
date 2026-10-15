const test = require("node:test");
const assert = require("node:assert/strict");

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

const systemSegment = (timestamp, text) => ({ source: "system", timestamp, text });
const micSegment = (timestamp, text) => ({ source: "mic", timestamp, text });

// Exact intervals and persisted timestamps from the synthetic note 71 replay.
// Both Bob turns begin with the same diarizer error, but Bob owns the majority
// of each spoken turn. Keep this fixture independent of the merge algorithm.
const capturedIntervals = [
  { start: 15.725, end: 23.082, speaker: "speaker_00" },
  { start: 24.702, end: 26.963, speaker: "speaker_00" },
  { start: 25.968, end: 26.255, speaker: "speaker_01" },
  { start: 26.963, end: 32.87, speaker: "speaker_01" },
  { start: 38.725, end: 46.083, speaker: "speaker_00" },
  { start: 47.703, end: 49.964, speaker: "speaker_00" },
  { start: 48.968, end: 49.255, speaker: "speaker_01" },
  { start: 49.964, end: 55.87, speaker: "speaker_01" },
];
const capturedTranscript = [
  micSegment(11.655, "Local introduction"),
  systemSegment(15.768, "Alice first turn"),
  systemSegment(24.769, "Bob first turn"),
  micSegment(34.662, "Local follow-up"),
  systemSegment(38.766, "Alice final turn"),
  systemSegment(47.768, "Bob final turn"),
];

test("captured final Bob turn keeps the same speaker as the earlier Bob turn", () => {
  const manager = new DiarizationManager();
  const input = structuredClone(capturedTranscript);
  const intervals = structuredClone(capturedIntervals);
  const merged = manager.mergeWithTranscript(input, intervals);

  assert.deepEqual(
    merged.map((segment) => segment.speaker),
    ["you", "speaker_0", "speaker_1", "you", "speaker_0", "speaker_1"]
  );
  assert.deepEqual(
    merged.map(({ timestamp, source, text }) => ({ timestamp, source, text })),
    capturedTranscript
  );
  assert.deepEqual(input, capturedTranscript);
  assert.deepEqual(intervals, capturedIntervals);
});

test("captured first Bob turn remains Bob when it is the last transcript entry", () => {
  const manager = new DiarizationManager();
  const merged = manager.mergeWithTranscript(capturedTranscript.slice(0, 3), capturedIntervals);

  assert.equal(merged[2].speaker, "speaker_1");
  assert.equal(merged[2].timestamp, 24.769);
});

test("long silence does not lend a later speaker's speech to the final turn", () => {
  const manager = new DiarizationManager();
  const merged = manager.mergeWithTranscript(
    [systemSegment(0.2, "A short first turn")],
    [
      { start: 0, end: 2, speaker: "speaker_00" },
      { start: 100, end: 120, speaker: "speaker_01" },
    ]
  );

  assert.equal(merged[0].speaker, "speaker_0");
});

for (const end of [2, 3]) {
  test(`a short pause does not discard final-turn evidence ending at ${end}s`, () => {
    const manager = new DiarizationManager();
    const merged = manager.mergeWithTranscript(
      [systemSegment(0, "A complete final turn with a short pause")],
      [
        { start: 0, end: 0.5, speaker: "speaker_00" },
        { start: 1, end, speaker: "speaker_01" },
      ]
    );

    assert.equal(merged[0].speaker, "speaker_1");
  });
}

test("a turn with no overlapping evidence retains its midpoint nearest-speaker fallback", () => {
  const manager = new DiarizationManager();
  const merged = manager.mergeWithTranscript(
    [systemSegment(10, "A turn within missing diarization"), systemSegment(20, "The next turn")],
    [
      { start: 0, end: 8, speaker: "speaker_00" },
      { start: 21, end: 30, speaker: "speaker_01" },
    ]
  );

  // The known 10–20s window has midpoint 15s, nearer to speaker_01.
  assert.equal(merged[0].speaker, "speaker_1");
});

test("an existing next-source boundary still includes speech after a long pause", () => {
  const manager = new DiarizationManager();
  const merged = manager.mergeWithTranscript(
    [systemSegment(0.2, "An earlier turn"), systemSegment(200, "The next known turn")],
    [
      { start: 0, end: 2, speaker: "speaker_00" },
      { start: 100, end: 120, speaker: "speaker_01" },
    ]
  );

  assert.equal(merged[0].speaker, "speaker_1");
});

test("a pause within an earlier turn does not replace its known next-source boundary", () => {
  const manager = new DiarizationManager();
  const merged = manager.mergeWithTranscript(
    [systemSegment(0, "Bob's complete turn"), systemSegment(10, "Alice's next turn")],
    [
      { start: 0, end: 2, speaker: "speaker_00" },
      { start: 2.6, end: 9, speaker: "speaker_01" },
      { start: 10, end: 15, speaker: "speaker_00" },
    ]
  );

  assert.deepEqual(
    merged.map((segment) => segment.speaker),
    ["speaker_1", "speaker_0"]
  );
});

test("disjoint fragments count together within a known next-source boundary", () => {
  const manager = new DiarizationManager();
  const merged = manager.mergeWithTranscript(
    [systemSegment(0, "A complete turn with pauses"), systemSegment(10, "The next turn")],
    [
      { start: 0, end: 3, speaker: "speaker_00" },
      { start: 3.6, end: 5.6, speaker: "speaker_01" },
      { start: 6.2, end: 8.2, speaker: "speaker_01" },
      { start: 10, end: 15, speaker: "speaker_00" },
    ]
  );

  assert.equal(merged[0].speaker, "speaker_1");
});

test("fragmented speech from one speaker outweighs a single longer competing interval", () => {
  const manager = new DiarizationManager();
  const merged = manager.mergeWithTranscript(
    [systemSegment(0, "One complete turn")],
    [
      { start: 0, end: 3, speaker: "speaker_00" },
      { start: 3, end: 5, speaker: "speaker_01" },
      { start: 5, end: 7, speaker: "speaker_01" },
    ]
  );

  assert.equal(merged[0].speaker, "speaker_1");
});

test("duplicate and overlapping intervals do not multiply a speaker's vote", () => {
  const manager = new DiarizationManager();
  const merged = manager.mergeWithTranscript(
    [systemSegment(0, "One complete turn")],
    [
      { start: 0, end: 2, speaker: "speaker_00" },
      { start: 0, end: 2, speaker: "speaker_00" },
      { start: 0.5, end: 2, speaker: "speaker_00" },
      { start: 2, end: 5, speaker: "speaker_01" },
    ]
  );

  // speaker_00 owns two seconds, not 5.5; speaker_01 owns three.
  assert.equal(merged[0].speaker, "speaker_1");
});

test("an unsorted contained interval does not cut off the rest of an overlapping turn", () => {
  const manager = new DiarizationManager();
  const merged = manager.mergeWithTranscript(
    [systemSegment(0, "One overlapping turn")],
    [
      { start: 0, end: 4, speaker: "speaker_00" },
      { start: 3, end: 8, speaker: "speaker_01" },
      { start: 1, end: 2, speaker: "speaker_00" },
    ]
  );

  assert.equal(merged[0].speaker, "speaker_1");
});

test("the next same-source transcript start limits a connected diarization span", () => {
  const manager = new DiarizationManager();
  const merged = manager.mergeWithTranscript(
    [systemSegment(0, "Alice"), micSegment(1, "Local aside"), systemSegment(3, "Bob")],
    [
      { start: 0, end: 3, speaker: "speaker_00" },
      { start: 3, end: 20, speaker: "speaker_01" },
    ]
  );

  assert.deepEqual(
    merged.map((segment) => segment.speaker),
    ["speaker_0", "you", "speaker_1"]
  );
});

for (const lock of [
  { speakerLocked: true },
  { speakerStatus: "locked" },
  { speakerStatus: "user_locked" },
  { speakerLockSource: "user" },
]) {
  test(`captured final turn preserves a user speaker lock ${JSON.stringify(lock)}`, () => {
    const manager = new DiarizationManager();
    const transcript = capturedTranscript.map((segment, index) =>
      index === 5
        ? { ...segment, speaker: "user-selected-speaker", speakerName: "Chosen name", ...lock }
        : { ...segment }
    );
    const merged = manager.mergeWithTranscript(transcript, capturedIntervals);

    assert.equal(merged[5].speaker, "user-selected-speaker");
    assert.equal(merged[5].speakerName, "Chosen name");
    assert.equal(merged[5].speakerStatus, "locked");
    assert.equal(merged[5].timestamp, 47.768);
  });
}

for (const diarizedSource of ["system", "mic"]) {
  test(`a locked mic speaker survives refinement of the ${diarizedSource} track`, () => {
    const manager = new DiarizationManager();
    const merged = manager.mergeWithTranscript(
      [
        {
          ...micSegment(0, "A manually identified speaker"),
          speaker: "chosen-mic-speaker",
          speakerName: "Chosen mic name",
          speakerLocked: true,
        },
      ],
      [
        { start: 0, end: 3, speaker: "speaker_00" },
        { start: 3, end: 10, speaker: "speaker_01" },
      ],
      { diarizedSource }
    );

    assert.equal(merged[0].speaker, "chosen-mic-speaker");
    assert.equal(merged[0].speakerName, "Chosen mic name");
    assert.equal(merged[0].speakerStatus, "locked");
    assert.equal(merged[0].timestamp, 0);
  });
}

test("a segment between clusters takes the nearest cluster, not the first", () => {
  const manager = new DiarizationManager();

  // With no intersecting speech, midpoint 51.25s is nearer to speaker_1.
  const merged = manager.mergeWithTranscript(
    [systemSegment(50, "so where did we land on pricing")],
    [
      { start: 0, end: 5, speaker: "speaker_0" },
      { start: 60, end: 70, speaker: "speaker_1" },
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

  // The connected speech spans 50s–53s. speaker_0 overlaps 0.5s and starts exactly at
  // the segment, so it is both the first cluster and a zero-distance match;
  // speaker_1 overlaps 2.5s and must win on overlap.
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
      // With no intersecting speech, midpoint 51.25s is nearer to speaker_01.
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

  const merged = manager.mergeWithTranscript(
    [
      systemSegment(10, "the quarterly revenue forecast slipped again"),
      {
        ...micSegment(10.5, "the quarterly revenue forecast slipped again"),
        likelyRenderBleed: true,
      },
    ],
    [
      { start: 0, end: 5, speaker: "speaker_00" },
      { start: 10, end: 20, speaker: "speaker_01" },
    ],
    { diarizedSource: "mic" }
  );

  assert.equal(merged.length, 1);
  assert.equal(merged[0].source, "system");
});

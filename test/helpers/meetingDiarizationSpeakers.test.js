const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const handlersModulePath = require.resolve("../../src/helpers/ipcHandlers");
const diarizationModulePath = require.resolve("../../src/helpers/diarization");
const originalLoad = Module._load;

const electronStub = {
  app: {
    getPath: () => os.tmpdir(),
    getName: () => "test",
    getVersion: () => "0.0.0",
    isPackaged: false,
    on: () => {},
    requestSingleInstanceLock: () => true,
  },
  ipcMain: { handle: () => {}, on: () => {}, removeHandler: () => {} },
  net: {},
  BrowserWindow: class BrowserWindow {
    static getAllWindows() {
      return [];
    }
  },
  shell: {},
  dialog: {},
  screen: { getPrimaryDisplay: () => ({ workAreaSize: { width: 0, height: 0 } }) },
  systemPreferences: { getMediaAccessStatus: () => "granted" },
  session: { fromPartition: () => ({}) },
  clipboard: {},
  nativeImage: {},
  globalShortcut: {},
  utilityProcess: {},
  MessageChannelMain: class {},
};

// Voices per cluster id; dot product stands in for cosine on unit vectors.
let voices = new Map();
let voicesUnreadable = false;
let embeddingModelAvailable = false;
const speakerEmbeddingsStub = {
  isAvailable: () => embeddingModelAvailable,
  extractClusterCentroids: async () => {
    if (voicesUnreadable) throw new Error("ONNX worker crashed");
    return voices;
  },
  cosineSimilarity: (a, b) => a.reduce((sum, value, i) => sum + value * b[i], 0),
};

Module._load = function loadWithMocks(request, parent, isMain) {
  if (request === "electron") return electronStub;
  if (parent?.filename === handlersModulePath && request === "./speakerEmbeddings") {
    return speakerEmbeddingsStub;
  }
  return originalLoad.call(this, request, parent, isMain);
};

const START_MS = 1_760_000_000_000;
let IPCHandlers;
let DiarizationManager;
let tmpDir;

test.before(() => {
  delete require.cache[handlersModulePath];
  delete require.cache[diarizationModulePath];
  IPCHandlers = require(handlersModulePath);
  DiarizationManager = require(diarizationModulePath);
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ow-meeting-diarize-test-"));
});

test.after(() => {
  Module._load = originalLoad;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// Turns of `seconds` every 20 s, alternating between the given clusters.
function turns(speakers, count, seconds) {
  return Array.from({ length: count }, (_, i) => ({
    start: i * 20,
    end: i * 20 + seconds,
    speaker: speakers[i % speakers.length],
  }));
}

// Runs the post-call path the way stopping a meeting does, with one transcript
// line per diarized turn of 2 s or more, and returns the labelled lines.
function diarizeMeeting(
  diarizerOutput,
  { sessionConfig = null, source = "system", liveSpeakerState = null, liveLabel = {} } = {}
) {
  const diarizationManager = Object.assign(new DiarizationManager(), {
    isAvailable: () => true,
    convertRawPcmToWav: async () => {
      const wavPath = path.join(tmpDir, `meeting-${Date.now()}-${Math.random()}.wav`);
      fs.writeFileSync(wavPath, Buffer.alloc(32000 * 600));
      return wavPath;
    },
    diarize: async () => diarizerOutput,
  });
  const handlers = Object.assign(Object.create(IPCHandlers.prototype), {
    diarizationManager,
    speakerDiarizationEnabled: true,
    databaseManager: { getNote: () => null, getSpeakerProfiles: () => [] },
  });
  const transcript = diarizerOutput
    .filter((turn) => turn.end - turn.start >= 2)
    .map((turn, i) => ({
      id: `line-${i}`,
      text: `line ${i}`,
      source,
      timestamp: START_MS + turn.start * 1000,
      ...liveLabel,
    }));

  return new Promise((resolve) => {
    handlers._startOrSkipDiarization(
      "session",
      path.join(tmpDir, "meeting.pcm"),
      START_MS,
      transcript,
      { isDestroyed: () => false, webContents: { send: (_channel, payload) => resolve(payload) } },
      liveSpeakerState,
      sessionConfig,
      null,
      source
    );
  }).then((payload) => ({ lines: payload.segments }));
}

const speakersOf = (lines) => [...new Set(lines.map((line) => line.speaker))].sort();

test.beforeEach(() => {
  voices = new Map();
  voicesUnreadable = false;
  embeddingModelAvailable = false;
});

// #2641: with the count left at its default, every remote voice ended up as
// one speaker, however many people spoke.
test("a call with three remote voices keeps all three when no count is set", async () => {
  voices = new Map([
    ["speaker_00", [1, 0, 0]],
    ["speaker_01", [0, 1, 0]],
    ["speaker_02", [0, 0, 1]],
  ]);

  const { lines } = await diarizeMeeting(turns(["speaker_00", "speaker_01", "speaker_02"], 30, 8));

  assert.equal(speakersOf(lines).length, 3);
});

test("one remote voice split across clusters stays one speaker", async () => {
  voices = new Map([
    ["speaker_00", [1, 0]],
    ["speaker_01", [0.8, 0.6]],
  ]);

  const { lines } = await diarizeMeeting(turns(["speaker_00", "speaker_01"], 30, 8));

  assert.deepEqual(speakersOf(lines), ["speaker_0"]);
});

test("a one-on-one call's backchannel slivers stay with the one remote voice", async () => {
  const output = [
    ...turns(["speaker_00"], 40, 12),
    { start: 13, end: 14.5, speaker: "speaker_01" },
    { start: 33, end: 34.5, speaker: "speaker_01" },
  ];
  voices = new Map([["speaker_00", [1, 0]]]);

  const { lines } = await diarizeMeeting(output);

  assert.deepEqual(speakersOf(lines), ["speaker_0"]);
});

// A count set by hand is an upper bound on the speakers (#2021).
test("a count set by hand bounds the speakers instead of forcing the cluster count", async () => {
  voices = new Map([
    ["speaker_00", [1, 0, 0]],
    ["speaker_01", [0, 1, 0]],
    ["speaker_02", [0.3, 0.45, 0.84]],
  ]);
  const output = [
    ...turns(["speaker_00", "speaker_01"], 30, 8),
    { start: 610, end: 616, speaker: "speaker_02" },
    { start: 630, end: 636, speaker: "speaker_02" },
  ];

  const { lines } = await diarizeMeeting(output, {
    sessionConfig: { enabled: true, expectedCount: 3, explicit: true },
  });

  assert.equal(speakersOf(lines).length, 2);
  const labelAt = (seconds) => lines.find((line) => line.timestamp === seconds).speaker;
  assert.equal(labelAt(610), labelAt(20), "the third voice joins the nearer of the two");
});

// Sherpa splits even one voice into many clusters; without voices to merge them,
// a call with no count can't be told from a group call.
test("when voices can't be read, a call with no count keeps one remote speaker", async () => {
  voicesUnreadable = true;

  const { lines } = await diarizeMeeting(turns(["speaker_00", "speaker_01", "speaker_02"], 30, 8));

  assert.equal(speakersOf(lines).length, 1);
});

// A cluster whose voice can't be read (only sub-1.5 s turns, or a failed
// extraction) can't be told from a split of the one voice that was read.
test("a cluster without a readable voice doesn't split a one-on-one call", async () => {
  voices = new Map([["speaker_00", [1, 0]]]);
  const output = [
    ...turns(["speaker_00"], 30, 8),
    ...turns(["speaker_01"], 10, 3).map((turn) => ({
      ...turn,
      start: turn.start + 10,
      end: turn.end + 10,
    })),
  ];

  const { lines } = await diarizeMeeting(output);

  assert.deepEqual(speakersOf(lines), ["speaker_0"]);
});

// The cap counts voices, so a cluster without one, however long, mustn't take
// the place of a second voice.
test("a long cluster without a readable voice doesn't fold a second voice into the first", async () => {
  voices = new Map([
    ["speaker_00", [1, 0]],
    ["speaker_01", [0, 1]],
  ]);
  const output = [
    ...turns(["speaker_00"], 30, 8),
    ...turns(["speaker_02"], 30, 3).map((turn) => ({
      ...turn,
      start: turn.start + 10,
      end: turn.end + 10,
    })),
    ...turns(["speaker_01"], 10, 8).map((turn) => ({
      ...turn,
      start: turn.start + 600,
      end: turn.end + 600,
    })),
  ];

  const { lines } = await diarizeMeeting(output);

  const labelAt = (seconds) => lines.find((line) => line.timestamp === seconds).speaker;
  assert.notEqual(labelAt(600), labelAt(0));
});

// In person, the mic track carries the user, and short replies beside them are
// someone else, not slivers of one voice.
test("an in-person session keeps a brief second voice beside the user", async () => {
  voices = new Map([
    ["speaker_00", [1, 0]],
    ["speaker_01", [0, 1]],
  ]);
  const output = [
    ...turns(["speaker_00"], 40, 12),
    { start: 13, end: 15, speaker: "speaker_01" },
    { start: 33, end: 35, speaker: "speaker_01" },
  ];

  const { lines } = await diarizeMeeting(output, { source: "mic" });

  assert.equal(speakersOf(lines).length, 2);
});

// With no count, live identification labels every remote line with its one
// speaker, and that speaker's name with it. After the split the name belongs
// to the voice it matches only.
test("a live speaker's name stays only on the voice it matches once the call is split", async () => {
  embeddingModelAvailable = true;
  voices = new Map([
    ["speaker_00", [1, 0]],
    ["speaker_01", [0, 1]],
  ]);

  const { lines } = await diarizeMeeting(turns(["speaker_00", "speaker_01"], 30, 8), {
    liveSpeakerState: { speaker_0: { displayName: "Bob", embedding: [1, 0] } },
    liveLabel: { speaker: "speaker_0", speakerName: "Bob" },
  });

  const namesBySpeaker = new Map();
  for (const line of lines) {
    namesBySpeaker.set(
      line.speaker,
      new Set([...(namesBySpeaker.get(line.speaker) ?? []), line.speakerName])
    );
  }
  assert.deepEqual([...namesBySpeaker].map(([speaker, names]) => [speaker, [...names]]).sort(), [
    ["speaker_0", ["Bob"]],
    ["speaker_1", [null]],
  ]);
});

test("live names stay when the voices can't be read to place them", async () => {
  embeddingModelAvailable = true;
  voicesUnreadable = true;

  const { lines } = await diarizeMeeting(turns(["speaker_00", "speaker_01"], 30, 8), {
    sessionConfig: { enabled: true, expectedCount: 3, explicit: true },
    liveSpeakerState: { speaker_0: { displayName: "Bob", embedding: [1, 0] } },
    liveLabel: { speaker: "speaker_0", speakerName: "Bob" },
  });

  assert.equal(speakersOf(lines).length, 2);
  assert.deepEqual([...new Set(lines.map((line) => line.speakerName))], ["Bob"]);
});

// Without live identification (macOS loopback), the renderer still names a 1:1
// call's remote lines after the attendee. With one voice there is nothing to
// place, so that name stays.
test("a single remote voice keeps its name when live identification didn't run", async () => {
  embeddingModelAvailable = true;
  voices = new Map([["speaker_00", [1, 0]]]);

  const { lines } = await diarizeMeeting(turns(["speaker_00"], 30, 8), {
    sessionConfig: { enabled: true, expectedCount: 2, explicit: true },
    liveLabel: { speaker: "speaker_0", speakerName: "Alice" },
  });

  assert.deepEqual([...new Set(lines.map((line) => line.speakerName))], ["Alice"]);
});

// The renderer names lines from live identifications that main never stored a
// name for, and keeps a line's old value for an undefined field. Every line of
// a voice that matches no live speaker must carry an explicit null.
test("lines main holds no name for still clear the renderer's copy after a split", async () => {
  embeddingModelAvailable = true;
  voices = new Map([
    ["speaker_00", [1, 0]],
    ["speaker_01", [0, 1]],
  ]);

  const { lines } = await diarizeMeeting(turns(["speaker_00", "speaker_01"], 30, 8), {
    liveSpeakerState: { speaker_0: { displayName: "Bob", embedding: [1, 0] } },
    liveLabel: { speaker: "speaker_0" },
  });

  const unmatched = lines.filter((line) => line.speaker === "speaker_1");
  assert.ok(unmatched.length > 0);
  assert.ok(unmatched.every((line) => line.speakerName === null));
});

test("two people in person stay apart even when their voices are close", async () => {
  voices = new Map([
    ["speaker_00", [1, 0]],
    ["speaker_01", [0.6, 0.8]],
  ]);

  const { lines } = await diarizeMeeting(turns(["speaker_00", "speaker_01"], 30, 8), {
    source: "mic",
  });

  assert.equal(speakersOf(lines).length, 2);
});

// The one-on-one rule is for calls with no count: someone told there are more
// people keeps a second voice, however briefly it speaks.
test("a count set by hand keeps a brief second remote voice", async () => {
  voices = new Map([
    ["speaker_00", [1, 0]],
    ["speaker_01", [0, 1]],
  ]);
  const output = [
    ...turns(["speaker_00"], 40, 12),
    { start: 13, end: 15, speaker: "speaker_01" },
    { start: 33, end: 35, speaker: "speaker_01" },
  ];

  const { lines } = await diarizeMeeting(output, {
    sessionConfig: { enabled: true, expectedCount: 3, explicit: true },
  });

  assert.equal(speakersOf(lines).length, 2);
});

test("a live name goes to the voice it sounds most like, not the first one close enough", async () => {
  embeddingModelAvailable = true;
  voices = new Map([
    ["speaker_00", [0.62, 0.78, 0]],
    ["speaker_01", [0.9, -0.3, 0.3]],
  ]);

  const { lines } = await diarizeMeeting(turns(["speaker_00", "speaker_01"], 30, 8), {
    liveSpeakerState: { speaker_0: { displayName: "Bob", embedding: [1, 0, 0] } },
    liveLabel: { speaker: "speaker_0", speakerName: "Bob" },
  });

  const namesOf = (speaker) => [
    ...new Set(lines.filter((line) => line.speaker === speaker).map((line) => line.speakerName)),
  ];
  assert.deepEqual(namesOf("speaker_1"), ["Bob"]);
  assert.deepEqual(namesOf("speaker_0"), [null]);
});

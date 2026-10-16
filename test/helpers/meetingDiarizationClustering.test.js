const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const handlersModulePath = require.resolve("../../src/helpers/ipcHandlers");
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
  BrowserWindow: class {
    static getAllWindows() {
      return [];
    }
  },
  shell: {},
  dialog: {},
  net: {},
  session: {},
  clipboard: {},
  nativeImage: {},
  globalShortcut: {},
  utilityProcess: {},
  MessageChannelMain: class {},
  screen: { getPrimaryDisplay: () => ({ workAreaSize: { width: 0, height: 0 } }) },
  systemPreferences: { getMediaAccessStatus: () => "granted" },
};

Module._load = function (request, parent, isMain) {
  if (request === "electron") return electronStub;
  if (request === "./speakerEmbeddings" && parent?.filename === handlersModulePath) {
    return { isAvailable: () => false };
  }
  return originalLoad.call(this, request, parent, isMain);
};
const IPCHandlers = require(handlersModulePath);
const DiarizationManager = require("../../src/helpers/diarization");
test.after(() => {
  Module._load = originalLoad;
});

// Captured real native output for the same 61.3s PCM: forced count two
// collapses both voices; automatic clustering keeps the dominant voice in
// each turn. These are recorded outputs, not a simulated clustering algorithm.
// PCM SHA256: 8023eb75da0aab717fead6639d2336c6b2f9d6849167afedd738fb526d6d77df.
const automatic = [
  { start: 12.788, end: 20.213, speaker: "speaker_03" },
  { start: 21.8, end: 23.977, speaker: "speaker_02" },
  { start: 23.977, end: 29.984, speaker: "speaker_04" },
  { start: 35.789, end: 43.214, speaker: "speaker_03" },
  { start: 44.8, end: 46.977, speaker: "speaker_02" },
  { start: 46.977, end: 53.002, speaker: "speaker_04" },
];
const forced = [
  { start: 12.788, end: 20.23, speaker: "speaker_00" },
  { start: 21.783, end: 29.984, speaker: "speaker_00" },
  { start: 35.789, end: 43.231, speaker: "speaker_00" },
  { start: 44.783, end: 53.002, speaker: "speaker_00" },
];
const captured = [
  { timestamp: 9.253, source: "mic", text: "Local introduction" },
  { timestamp: 13.931, source: "system", text: "Alice first turn" },
  { timestamp: 22.054, source: "system", text: "Bob first turn" },
  { timestamp: 32.287, source: "mic", text: "Local follow-up" },
  { timestamp: 35.857, source: "system", text: "Alice final turn" },
  { timestamp: 44.858, source: "system", text: "Bob final turn" },
].map((segment, index) => ({ ...segment, id: `captured-${index}` }));
const expected = ["you", "speaker_0", "speaker_1", "you", "speaker_0", "speaker_1"];

async function finish({
  transcript = captured,
  intervals = automatic,
  native = null,
  sessionConfig = { enabled: true, expectedCount: 3, explicit: true },
  note = null,
  diarizedSource = "system",
  liveSpeakerState = null,
} = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ow-meeting-clustering-"));
  const pcmPath = path.join(dir, "capture.pcm");
  const wavPath = path.join(dir, "capture.wav");
  fs.writeFileSync(pcmPath, "fixture");
  fs.writeFileSync(wavPath, "fixture");
  const manager = new DiarizationManager();
  const calls = [];
  manager.isAvailable = () => true;
  manager.convertRawPcmToWav = async () => wavPath;
  manager.diarize = async (_wav, options = {}) => {
    calls.push(options);
    return structuredClone(native ? native(options) : intervals);
  };
  const target = Object.assign(Object.create(IPCHandlers.prototype), {
    diarizationManager: manager,
    databaseManager: { getNote: () => note },
  });
  try {
    const payload = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("diarization did not complete")), 3000);
      target._startOrSkipDiarization(
        "session",
        pcmPath,
        0,
        structuredClone(transcript),
        {
          isDestroyed: () => false,
          webContents: {
            send: (_channel, data) => {
              clearTimeout(timeout);
              resolve(data);
            },
          },
        },
        liveSpeakerState,
        sessionConfig,
        42,
        diarizedSource
      );
    });
    assert.equal(payload.noteId, 42);
    assert.equal(payload.sessionId, "session");
    assert.equal(fs.existsSync(pcmPath), false);
    assert.equal(fs.existsSync(wavPath), false);
    return { payload, calls };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const optionsSensitiveNative = (options) => (options.numSpeakers > 0 ? forced : automatic);

test("captured two-voice meeting preserves both Bob turns using automatic clustering", async () => {
  const { payload, calls } = await finish({ native: optionsSensitiveNative });
  assert.deepEqual(
    payload.segments.map((s) => s.speaker),
    expected
  );
  assert.ok(calls.every((options) => options.numSpeakers == null || options.numSpeakers < 0));
  assert.deepEqual(
    payload.segments.map(({ id, text, timestamp, source }) => ({ id, text, timestamp, source })),
    captured
  );
});

for (const kind of ["correct", "incorrect", "changing"]) {
  test(`offline acoustic evidence can refine ${kind} live labels`, async () => {
    const transcript = captured.map((s, i) => ({
      ...s,
      speaker:
        kind === "correct" ? expected[i] : kind === "incorrect" ? "speaker_7" : `speaker_${i}`,
      speakerStatus: "provisional",
    }));
    const { payload } = await finish({ transcript, native: optionsSensitiveNative });
    assert.deepEqual(
      payload.segments.map((s) => s.speaker),
      expected
    );
  });
}

test("a single voice may merge incorrect live labels despite a larger expected count", async () => {
  const transcript = [
    { source: "system", timestamp: 0, text: "Same voice first", speaker: "speaker_4" },
    { source: "system", timestamp: 5, text: "Same voice again", speaker: "speaker_7" },
  ];
  const { payload } = await finish({
    transcript,
    intervals: [{ start: 0, end: 10, speaker: "speaker_00" }],
  });
  assert.deepEqual(
    payload.segments.map((s) => s.speaker),
    ["speaker_0", "speaker_0"]
  );
});

test("short real turns remain separate when native evidence identifies them", async () => {
  const intervals = [
    { start: 0, end: 8, speaker: "speaker_00" },
    { start: 8.3, end: 9.1, speaker: "speaker_01" },
    { start: 10, end: 18, speaker: "speaker_00" },
  ];
  const transcript = intervals.map((s, i) => ({
    source: "system",
    timestamp: s.start,
    text: `Turn ${i}`,
  }));
  const { payload } = await finish({ transcript, intervals });
  assert.deepEqual(
    payload.segments.map((s) => s.speaker),
    ["speaker_0", "speaker_1", "speaker_0"]
  );
});

for (const config of [
  { name: "explicit one remote", sessionConfig: { expectedCount: 2, explicit: true }, cap: 1 },
  { name: "note roster count", sessionConfig: null, note: { expected_speaker_count: 3 }, cap: 2 },
  {
    name: "observed live count",
    sessionConfig: null,
    liveSpeakerState: { speaker_0: {}, speaker_1: {} },
    cap: 2,
  },
  { name: "default system count", sessionConfig: null, cap: 1 },
  {
    name: "mic total count",
    sessionConfig: { expectedCount: 2, explicit: true },
    diarizedSource: "mic",
    cap: 2,
  },
]) {
  test(`${config.name} remains a ceiling after automatic clustering`, async () => {
    const transcript = captured
      .filter((s) => s.source === "system")
      .map((s) => ({ ...s, source: config.diarizedSource || "system" }));
    const { payload, calls } = await finish({ ...config, transcript });
    assert.equal(new Set(payload.segments.map((s) => s.speaker)).size, config.cap);
    assert.ok(calls.every((options) => options.numSpeakers == null || options.numSpeakers < 0));
  });
}

test("single-speaker mic refinement keeps the local identity", async () => {
  const { payload } = await finish({
    diarizedSource: "mic",
    transcript: [{ source: "mic", timestamp: 0, text: "Local voice" }],
    intervals: [{ start: 0, end: 4, speaker: "speaker_00" }],
  });
  assert.equal(payload.segments[0].speaker, "you");
});

test("user-locked final Bob identity survives clustering and merge", async () => {
  const transcript = captured.map((s, i) =>
    i === 5
      ? {
          ...s,
          speaker: "chosen-bob",
          speakerName: "Bob chosen",
          speakerLocked: true,
        }
      : s
  );
  const { payload } = await finish({ transcript, native: optionsSensitiveNative });
  assert.equal(payload.segments[2].speaker, "speaker_1");
  assert.equal(payload.segments[5].speaker, "chosen-bob");
  assert.equal(payload.segments[5].speakerName, "Bob chosen");
  assert.equal(payload.segments[5].speakerStatus, "locked");
});

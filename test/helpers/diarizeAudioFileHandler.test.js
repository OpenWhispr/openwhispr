const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const handlersModulePath = require.resolve("../../src/helpers/ipcHandlers");
const originalLoad = Module._load;
const handlers = new Map();

const electronStub = {
  app: {
    getPath: () => os.tmpdir(),
    getName: () => "test",
    getVersion: () => "0.0.0",
    isPackaged: false,
    on: () => {},
    requestSingleInstanceLock: () => true,
  },
  ipcMain: {
    handle: (channel, fn) => handlers.set(channel, fn),
    on: () => {},
    removeHandler: () => {},
  },
  net: {},
  BrowserWindow: class BrowserWindow {
    static getAllWindows() {
      return [];
    }
    static fromWebContents() {
      return null;
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

// Voices are looked up by cluster id; tests set the centroids (or make the
// lookup fail) per case.
let centroidCalls = [];
let clusterCentroids = async () => new Map();
const speakerEmbeddingsStub = {
  extractClusterCentroids: (...args) => {
    centroidCalls.push(args);
    return clusterCentroids(...args);
  },
  cosineSimilarity: (a, b) => a.reduce((sum, value, i) => sum + value * b[i], 0),
};

// ffmpeg is not run: the handler only needs a WAV whose size gives a duration.
Module._load = function loadWithMocks(request, parent, isMain) {
  if (request === "electron") return electronStub;
  if (parent?.filename === handlersModulePath && request === "./ffmpegUtils") {
    return {
      ...originalLoad.call(this, request, parent, isMain),
      convertToWav: async (_input, output) => fs.writeFileSync(output, Buffer.alloc(32000)),
    };
  }
  if (parent?.filename === handlersModulePath && request === "./speakerEmbeddings") {
    return speakerEmbeddingsStub;
  }
  return originalLoad.call(this, request, parent, isMain);
};

function anything() {
  return new Proxy(function () {}, {
    get: (t, prop) => {
      if (prop === Symbol.toPrimitive || prop === "toString") return () => "";
      if (prop === "then") return undefined;
      return anything();
    },
    apply: () => anything(),
  });
}

let diarizeCalls = [];
let diarizerOutput = [];
let audioPath;
let handler;

test.before(() => {
  delete require.cache[handlersModulePath];
  const IPCHandlers = require(handlersModulePath);
  const Ctor = IPCHandlers.default || IPCHandlers;
  const target = {
    _uploadCancelRegistry: { register: () => ({ signal: undefined, release: () => {} }) },
    diarizationManager: {
      isModelDownloaded: () => true,
      diarize: async (_wavPath, options) => {
        diarizeCalls.push(options);
        return diarizerOutput;
      },
    },
  };
  Ctor.prototype.setupHandlers.call(
    new Proxy(target, { get: (t, prop) => (prop in t ? t[prop] : anything()) })
  );
  handler = handlers.get("diarize-audio-file");
  assert.ok(handler, "diarize-audio-file must be registered");

  audioPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ow-diarize-test-")), "call.mp3");
  fs.writeFileSync(audioPath, "");
  Ctor.prototype.approveAudioPath(audioPath);
});

test.beforeEach(() => {
  diarizeCalls = [];
  centroidCalls = [];
  clusterCentroids = async () => new Map();
});

test.after(() => {
  Module._load = originalLoad;
  fs.rmSync(path.dirname(audioPath), { recursive: true, force: true });
});

function cluster(speaker, count, seconds) {
  return Array.from({ length: count }, (_, i) => ({
    start: i * 20,
    end: i * 20 + seconds,
    speaker,
  }));
}

const speakersOf = (segments) => [...new Set(segments.map((s) => s.speaker))].sort();

// Forcing sherpa to 2 clusters on #2021's two-person call split short
// utterances from long ones, merging both real speakers and keeping a phantom.
// The requested count must never reach sherpa.
test("a requested speaker count still clusters automatically", async () => {
  diarizerOutput = [
    ...cluster("speaker_06", 79, 6.46),
    ...cluster("speaker_01", 85, 5.44),
    ...cluster("speaker_00", 23, 1.72),
  ];

  const result = await handler({}, audioPath, { numSpeakers: 2 });

  assert.equal(result.success, true);
  assert.equal(diarizeCalls.length, 1);
  // diarize() maps a missing count to --clustering.num-clusters=-1 (auto); its
  // default doesn't replace null, which would reach sherpa as "null".
  assert.equal(Object.hasOwn(diarizeCalls[0], "numSpeakers"), false);
  assert.deepEqual(speakersOf(result.segments), ["speaker_01", "speaker_06"]);
  assert.equal(centroidCalls.length, 0, "voices are only read when clusters exceed the cap");
});

test("a collapsed run returns no segments, so the plain transcript is kept", async () => {
  diarizerOutput = [...cluster("speaker_01", 165, 6.06), ...cluster("speaker_00", 35, 1.72)];

  const result = await handler({}, audioPath, {});

  assert.equal(result.success, true);
  assert.deepEqual(result.segments, []);
  assert.equal(result.durationSeconds, 1);
});

test("a requested speaker count caps the clusters automatic clustering finds", async () => {
  diarizerOutput = [
    ...cluster("speaker_0", 80, 6),
    ...cluster("speaker_1", 60, 6),
    ...cluster("speaker_2", 40, 6),
  ];

  const result = await handler({}, audioPath, { numSpeakers: 2 });

  assert.deepEqual(speakersOf(result.segments), ["speaker_0", "speaker_1"]);
});

test("an extra cluster goes to the requested speaker whose voice it matches", async () => {
  diarizerOutput = [
    ...cluster("speaker_0", 80, 6),
    ...cluster("speaker_1", 60, 6),
    ...cluster("speaker_2", 40, 6),
  ];
  clusterCentroids = async () =>
    new Map([
      ["speaker_0", [1, 0]],
      ["speaker_1", [0, 1]],
      ["speaker_2", [0.2, 0.8]],
    ]);

  const result = await handler({}, audioPath, { numSpeakers: 2 });

  assert.equal(centroidCalls.length, 1);
  assert.equal(result.segments.filter((s) => s.speaker === "speaker_1").length, 100);
  assert.equal(result.segments.filter((s) => s.speaker === "speaker_0").length, 80);
});

test("extra clusters fold into the largest when voices can't be read", async () => {
  diarizerOutput = [
    ...cluster("speaker_0", 80, 6),
    ...cluster("speaker_1", 60, 6),
    ...cluster("speaker_2", 40, 6),
  ];
  clusterCentroids = async () => {
    throw new Error("Speaker embedding model not found");
  };

  const result = await handler({}, audioPath, { numSpeakers: 2 });

  assert.equal(result.success, true);
  assert.equal(result.segments.filter((s) => s.speaker === "speaker_0").length, 120);
});

// Dropping the 3 % phantom first would lift the interviewee from 88 % to
// 90.7 % of the speech and discard a correctly labelled interview.
test("a solo recording with a stray blip keeps its one speaker", async () => {
  diarizerOutput = [...cluster("speaker_0", 100, 6), ...cluster("speaker_1", 1, 0.45)];

  const result = await handler({}, audioPath, {});

  assert.deepEqual(speakersOf(result.segments), ["speaker_0"]);
});

test("an interview with short questions keeps its labels", async () => {
  diarizerOutput = [
    ...cluster("speaker_0", 88, 10),
    ...cluster("speaker_1", 36, 2.5),
    ...cluster("speaker_2", 20, 1.5),
  ];

  const result = await handler({}, audioPath, {});

  assert.deepEqual(speakersOf(result.segments), ["speaker_0", "speaker_1"]);
});

test("a request for one speaker labels one speaker instead of discarding the run", async () => {
  diarizerOutput = [...cluster("speaker_01", 165, 6.06), ...cluster("speaker_00", 35, 1.72)];

  const result = await handler({}, audioPath, { numSpeakers: 1 });

  assert.equal(result.segments.length, 200);
  assert.deepEqual(speakersOf(result.segments), ["speaker_01"]);
});

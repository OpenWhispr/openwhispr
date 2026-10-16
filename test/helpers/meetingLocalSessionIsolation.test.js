const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const fs = require("node:fs");
const { EventEmitter } = require("node:events");
const { deferred } = require("./harness/deferred");

const handlersModulePath = require.resolve("../../src/helpers/ipcHandlers");
const originalLoad = Module._load;
const handlers = new Map();
const listeners = new Map();
const electronStub = {
  app: {
    getPath: () => "/tmp",
    getName: () => "test",
    getVersion: () => "0.0.0",
    isPackaged: false,
    on() {},
    requestSingleInstanceLock: () => true,
  },
  ipcMain: {
    handle: (channel, handler) => handlers.set(channel, handler),
    on: (channel, handler) => listeners.set(channel, handler),
    removeHandler() {},
  },
  net: { fetch: async () => ({ ok: true, status: 200, json: async () => ({}) }) },
  BrowserWindow: class {
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

Module._load = function loadWithMocks(request, parent, isMain) {
  if (request === "electron") return electronStub;
  if (parent?.filename === handlersModulePath && request === "./debugLogger") {
    return new Proxy({}, { get: () => () => {} });
  }
  return originalLoad.call(this, request, parent, isMain);
};
test.after(() => {
  Module._load = originalLoad;
});

function anything() {
  return new Proxy(function () {}, {
    get: (_target, property) => {
      if (property === Symbol.toPrimitive || property === "toString") return () => "";
      if (property === "then") return undefined;
      return anything();
    },
    apply: () => anything(),
  });
}

// LOCAL_MEETING_CHUNK_INTERVAL_MS in ipcHandlers.js. Ticks fire only the local
// transcription timer, not the other intervals a start registers.
const LOCAL_MEETING_CHUNK_INTERVAL_MS = 5000;
const SAMPLE_BY_WORD = { "alpha-one": 8000, "alpha-two": 8200, bravo: 9000 };
const WORD_BY_SAMPLE = Object.fromEntries(
  Object.entries(SAMPLE_BY_WORD).map(([word, sample]) => [sample, word])
);

const settle = () => new Promise((resolve) => setImmediate(resolve));

async function waitFor(predicate) {
  for (let i = 0; i < 100 && !predicate(); i++) await settle();
  assert.ok(predicate(), "condition never became true");
}

function scenario(t) {
  const timers = new Map();
  t.mock.method(global, "setInterval", (callback, delay) => {
    const id = {};
    timers.set(id, { callback, delay });
    return id;
  });
  t.mock.method(global, "clearInterval", (id) => timers.delete(id));
  t.mock.method(fs, "createWriteStream", () => ({ write() {}, end: (done) => done?.() }));

  // The fake decoder "hears" each utterance's sample value, so its text names
  // exactly the audio a pass was given. The first pass waits for the test.
  const firstDecode = deferred();
  let decodeCount = 0;
  const diarized = [];
  const target = {
    activeMeetingSpeakerConfig: null,
    _resolveInitialMeetingSpeakerConfig: () => ({ enabled: false }),
    _resolveWhisperVadOptions: () => ({}),
    audioTapManager: { isSupported: () => true, start: async () => {}, stop: async () => {} },
    meetingAecManager: { isAvailable: () => false, stop: async () => {} },
    whisperManager: {
      transcribeLocalWhisper: async (wav) => {
        decodeCount++;
        const heard = new Set();
        for (let i = 44; i < wav.length; i += 2) {
          const word = WORD_BY_SAMPLE[wav.readInt16LE(i)];
          if (word) heard.add(word);
        }
        if (decodeCount === 1) await firstDecode.promise;
        return { success: true, text: [...heard].join(" ") };
      },
    },
    _startOrSkipDiarization: (_id, _pcm, _startedAt, segments) =>
      diarized.push(segments.map((segment) => segment.text)),
  };
  const IPCHandlers = require(handlersModulePath);
  IPCHandlers.prototype.setupHandlers.call(
    new Proxy(target, {
      get: (value, property) => (property in value ? value[property] : anything()),
    })
  );

  const owner = new EventEmitter();
  owner.isDestroyed = () => false;
  const invoke = (channel, ...args) => handlers.get(channel)({ sender: owner }, ...args);
  const say = (word) => {
    const pcm = Buffer.alloc(4800);
    for (let i = 0; i < pcm.length; i += 2) pcm.writeInt16LE(SAMPLE_BY_WORD[word], i);
    listeners.get("meeting-transcription-send")({}, pcm, "system");
  };
  let firedTimer = null;
  const tick = () => {
    const local = [...timers].filter(([, { delay }]) => delay === LOCAL_MEETING_CHUNK_INTERVAL_MS);
    assert.equal(local.length, 1, "expected one local transcription timer");
    [firedTimer] = local[0];
    local[0][1].callback();
  };
  return {
    diarized,
    say,
    tick,
    decodeCount: () => decodeCount,
    firedTimerCleared: () => !timers.has(firedTimer),
    releaseFirstDecode: firstDecode.resolve,
    start: (sessionId) =>
      invoke("meeting-transcription-start", {
        provider: "local",
        localProvider: "whisper",
        localModel: "base",
        sessionId,
      }),
    stop: (sessionId) => invoke("meeting-transcription-stop", sessionId),
  };
}

test("a pass still decoding at stop stays with its recording, not the next one", async (t) => {
  const s = scenario(t);
  assert.equal((await s.start("meeting-a")).success, true);

  s.say("alpha-one");
  s.tick();
  await waitFor(() => s.decodeCount() === 1);
  // Arrives while that pass decodes, so only a final pass at stop can pick it up.
  s.say("alpha-two");

  const stopA = s.stop("meeting-a");
  const startB = s.start("meeting-b");
  // Stop clears A's timer right before it reaches the pass still decoding.
  await waitFor(s.firedTimerCleared);
  s.releaseFirstDecode();

  const stoppedA = await stopA;
  assert.equal((await startB).success, true);
  s.say("bravo");
  s.tick();
  const stoppedB = await s.stop("meeting-b");

  assert.deepEqual(
    { transcripts: [stoppedA.transcript, stoppedB.transcript], diarized: s.diarized },
    {
      transcripts: ["alpha-one alpha-two", "bravo"],
      diarized: [["alpha-one", "alpha-two"], ["bravo"]],
    }
  );
});

test("a failed diarization still sends the transcript, so post-stop lines reach the note", async () => {
  const sent = deferred();
  const IPCHandlers = require(handlersModulePath);
  IPCHandlers.prototype._startOrSkipDiarization.call(
    {
      diarizationManager: {
        isAvailable: () => true,
        convertRawPcmToWav: async () => {
          throw new Error("diarizer crashed");
        },
      },
    },
    "diar-a",
    "/nonexistent/meeting-a.pcm",
    1,
    [
      { text: "alpha-one", source: "system", timestamp: 1 },
      { text: "alpha-two", source: "system", timestamp: 2 },
    ],
    {
      isDestroyed: () => false,
      webContents: { send: (_channel, payload) => sent.resolve(payload) },
    },
    null,
    { enabled: true }
  );

  const { segments } = await sent.promise;
  assert.deepEqual(
    segments.map((segment) => segment.text),
    ["alpha-one", "alpha-two"]
  );
});

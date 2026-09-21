const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

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

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function scenario(t, { decode, stream, online = false } = {}) {
  const timers = new Map();
  t.mock.method(global, "setInterval", (callback) => {
    const id = {};
    timers.set(id, callback);
    return id;
  });
  t.mock.method(global, "clearInterval", (id) => timers.delete(id));
  const calls = { decode: [], appended: [], shown: [], held: [], hidden: 0 };
  const target = {
    parakeetManager: {
      supportsOnlineStreaming: () => online,
      createOnlineStream: async () => {
        if (stream instanceof Error) throw stream;
        return stream;
      },
      transcribeLocalParakeet: async (audio, options) => {
        calls.decode.push({ audio, options });
        return decode ? decode(audio, options) : { success: true, text: "recognized" };
      },
    },
    windowManager: {
      showTranscriptionPreview: (text) => calls.shown.push(text),
      appendTranscriptionPreview: (text) => calls.appended.push(text),
      holdTranscriptionPreview: (options) => calls.held.push(options),
      hideTranscriptionPreview: () => {
        calls.hidden++;
      },
    },
  };
  const IPCHandlers = require(handlersModulePath);
  IPCHandlers.prototype.setupHandlers.call(
    new Proxy(target, {
      get: (value, property) => (property in value ? value[property] : anything()),
    })
  );
  const invoke = (channel, ...args) => handlers.get(channel)({}, ...args);
  const start = (model = "orukeet-v0.1.0") =>
    invoke("start-dictation-preview", {
      provider: "nvidia",
      model,
      language: "en",
      display: true,
    });
  const audio = () => {
    const pcm = Buffer.alloc(1600);
    for (let i = 0; i < pcm.length; i += 2) pcm.writeInt16LE(8000, i);
    listeners.get("dictation-preview-audio")({}, pcm);
  };
  t.after(() => invoke("dismiss-dictation-preview"));
  return {
    calls,
    invoke,
    start,
    audio,
    tick: () => Promise.all([...timers.values()].map((callback) => callback())),
  };
}

test("offline stop skips pending preview audio while final audio still reaches transcription", async (t) => {
  const s = scenario(t);
  await s.start();
  s.audio();
  assert.deepEqual(await s.invoke("stop-dictation-preview", { flushed: true }), {
    success: true,
    streamed: false,
    text: "",
  });
  assert.equal(s.calls.decode.length, 0, "the preview tail must not compete with final decoding");
  assert.equal(s.calls.held.length, 1);
  const finalAudio = Buffer.from("the complete MediaRecorder recording, including pre-roll");
  const result = await s.invoke("transcribe-local-parakeet", finalAudio, {
    model: "orukeet-v0.1.0",
    language: "en",
  });
  assert.equal(result.text, "recognized");
  assert.equal(s.calls.decode.length, 1);
  assert.strictEqual(s.calls.decode[0].audio, finalAudio);
});

test("regular offline previews still decode, but an in-flight result cannot append after stop", async (t) => {
  const pending = deferred();
  const s = scenario(t, { decode: () => pending.promise });
  await s.start();
  s.audio();
  const ticking = s.tick();
  assert.equal(s.calls.decode.length, 1);
  await s.invoke("stop-dictation-preview");
  pending.resolve({ success: true, text: "late preview" });
  await ticking;
  assert.deepEqual(s.calls.appended, []);
  assert.equal(s.calls.held.length, 1);
});

test("a cancelled preview cannot append or release the next session's in-flight guard", async (t) => {
  const old = deferred();
  const current = deferred();
  let requests = 0;
  const s = scenario(t, { decode: () => (++requests === 1 ? old.promise : current.promise) });
  await s.start();
  s.audio();
  const oldTick = s.tick();
  await s.invoke("dismiss-dictation-preview");
  await s.start("parakeet-tdt-0.6b-v3");
  s.audio();
  const currentTick = s.tick();
  old.resolve({ success: true, text: "stale session" });
  await oldTick;
  s.audio();
  await s.tick();
  assert.equal(requests, 2, "old completion must not clear the current busy guard");
  assert.deepEqual(s.calls.appended, []);
  current.resolve({ success: true, text: "current session" });
  await currentTick;
  assert.deepEqual(s.calls.appended, ["current session"]);
  assert.deepEqual(
    s.calls.decode.map(({ options }) => options.model),
    ["orukeet-v0.1.0", "parakeet-tdt-0.6b-v3"]
  );
});

test("online stop still flushes the stream and commits a complete result", async (t) => {
  const sent = [];
  let finishes = 0;
  const s = scenario(t, {
    online: true,
    stream: {
      sendPcm16: (pcm) => sent.push(pcm),
      finish: async () => {
        finishes++;
        return { text: "complete stream" };
      },
      abort() {},
    },
  });
  await s.start("online-model");
  s.audio();
  assert.deepEqual(await s.invoke("stop-dictation-preview", { flushed: true }), {
    success: true,
    streamed: true,
    text: "complete stream",
  });
  assert.equal(finishes, 1);
  assert.equal(sent.length, 1);
  assert.equal(s.calls.decode.length, 0);
  assert.deepEqual(s.calls.shown, ["", "complete stream"]);
});

for (const [label, flushed, result] of [
  ["renderer flush failure", false, { text: "partial" }],
  ["truncated server result", true, { text: "partial", truncated: true }],
]) {
  test(`online ${label} still requires the full-recording fallback`, async (t) => {
    const s = scenario(t, {
      online: true,
      stream: {
        sendPcm16() {},
        finish: async () => result,
        abort() {},
      },
    });
    await s.start("online-model");
    assert.deepEqual(await s.invoke("stop-dictation-preview", { flushed }), {
      success: true,
      streamed: false,
      text: "partial",
    });
  });
}

test("failed online startup skips the offline preview tail and leaves final decoding enabled", async (t) => {
  const s = scenario(t, { online: true, stream: new Error("stream unavailable") });
  await s.start("online-model");
  s.audio();
  assert.deepEqual(await s.invoke("stop-dictation-preview", { flushed: true }), {
    success: true,
    streamed: false,
    text: "",
  });
  assert.equal(s.calls.decode.length, 0);
});

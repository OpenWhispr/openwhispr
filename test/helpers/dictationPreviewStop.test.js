const { withDevicePolicy } = require("./harness/devicePolicy");
const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const { defaultDevicePolicy } = require("../../src/helpers/managedDevicePolicy");

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
    const id = { unref() {} };
    timers.set(id, callback);
    return id;
  });
  t.mock.method(global, "clearInterval", (id) => timers.delete(id));
  const calls = { decode: [], appended: [], shown: [], held: [], hidden: 0 };
  const target = {
    parakeetManager: {
      supportsOnlineStreaming: () => online,
      createOnlineStream: async (_model, options) => {
        calls.streamOptions = options;
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
    withDevicePolicy(
      new Proxy(target, {
        get: (value, property) => (property in value ? value[property] : anything()),
      })
    )
  );
  target._stopRemoteProductWork = IPCHandlers.prototype._stopRemoteProductWork.bind(target);
  target._retireDisallowedProductWork =
    IPCHandlers.prototype._retireDisallowedProductWork.bind(target);
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
    target,
    parakeet: target.parakeetManager,
    invoke,
    start,
    audio,
    setPolicy(change) {
      const policy = defaultDevicePolicy();
      policy.transcription.allowedModes = change === "local revoked" ? ["providers"] : ["local"];
      target.managedDevicePolicy.getSnapshot = () =>
        change === "invalid"
          ? { status: "invalid", managed: true, policy: null, code: "DEVICE_POLICY_INVALID" }
          : { status: "valid", managed: true, policy, localOnly: change === "allowed update" };
      target.effectivePolicyManager.getCurrent();
    },
    failStream: (error) => calls.streamOptions.onError(error),
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

for (const change of ["stop", "invalid", "local revoked"]) {
  test(`offline preview discards late output after ${change}`, async (t) => {
    const pending = deferred();
    const s = scenario(t, { decode: () => pending.promise });
    await s.start();
    s.audio();
    const ticking = s.tick();
    assert.equal(s.calls.decode.length, 1);
    if (change === "stop") await s.invoke("stop-dictation-preview");
    else s.setPolicy(change);
    pending.resolve({ success: true, text: "late preview" });
    await ticking;
    s.audio();
    await s.tick();
    assert.equal(s.calls.decode.length, 1);
    assert.deepEqual(s.calls.appended, []);
    if (change === "stop") assert.equal(s.calls.held.length, 1);
    else {
      assert.equal(s.calls.hidden, 1);
      assert.equal((await s.start()).code, "DEVICE_POLICY_BLOCKED");
    }
  });
}

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

for (const change of ["stop", "invalid", "local revoked", "allowed update"]) {
  test(`online preview handles ${change}`, async (t) => {
    const sent = [];
    let finishes = 0;
    let aborts = 0;
    const s = scenario(t, {
      online: true,
      stream: {
        sendPcm16: (pcm) => sent.push(pcm),
        finish: async () => {
          finishes++;
          return { text: "complete stream" };
        },
        abort() {
          aborts++;
        },
      },
    });
    await s.start("online-model");
    s.audio();
    const blocked = change === "invalid" || change === "local revoked";
    if (change !== "stop") {
      s.setPolicy(change);
      s.audio();
      s.calls.streamOptions.onUpdate("later preview");
    }
    const result = await s.invoke("stop-dictation-preview", { flushed: true });
    assert.equal(result.streamed, !blocked);
    assert.equal(result.text, blocked ? "" : "complete stream");
    assert.equal(finishes, blocked ? 0 : 1);
    assert.equal(aborts, blocked ? 1 : 0);
    assert.equal(sent.length, change === "allowed update" ? 2 : 1);
    assert.equal(s.calls.decode.length, 0);
    assert.deepEqual(
      s.calls.shown,
      blocked
        ? [""]
        : change === "stop"
          ? ["", "complete stream"]
          : ["", "later preview", "complete stream"]
    );
    if (blocked) {
      assert.equal(s.calls.hidden, 1);
      assert.equal((await s.start("online-model")).code, "DEVICE_POLICY_BLOCKED");
    }
  });
}

test("a realtime stop hides the preview of a stream revocation already closed", async (t) => {
  const s = scenario(t);
  s.target._dictationPreviewEnabled = true;
  s.target._dictationStreaming = { disconnect: async () => ({ text: "" }) };
  s.setPolicy("invalid");
  assert.equal(s.target._dictationStreaming, null);
  assert.deepEqual(await s.invoke("dictation-realtime-stop"), { success: true, text: "" });
  assert.equal(s.calls.hidden, 1);
});

test("local-mode revocation preserves a remote dictation preview", async (t) => {
  const s = scenario(t);
  await s.invoke("update-dictation-preview", "remote partial");
  s.setPolicy("local revoked");
  assert.deepEqual(s.calls.shown, ["remote partial"]);
  assert.equal(s.calls.hidden, 0);
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

const blockedModel = () =>
  Object.assign(new Error("Model blocked"), { code: "POLICY_MODEL_BLOCKED" });

for (const stage of ["start", "send", "finish", "callback", "chunk"]) {
  test(`policy denial during preview ${stage} is terminal and preserves its code`, async (t) => {
    const error = blockedModel();
    const s = scenario(t, {
      online: stage !== "chunk",
      decode: async () => {
        throw error;
      },
      stream:
        stage === "start"
          ? error
          : {
              sendPcm16() {
                if (stage === "send") throw error;
              },
              finish: async () => {
                throw error;
              },
              abort() {},
            },
    });
    const started = await s.start("online-model");
    if (stage === "start") assert.equal(started.code, error.code);
    assert.doesNotThrow(() => s.audio());
    if (stage === "callback") s.failStream(error);
    if (stage === "chunk") await s.tick();
    const result = await s.invoke("stop-dictation-preview");
    assert.equal(result.success, false);
    assert.equal(result.code, error.code);
    s.audio();
    await s.tick();
    assert.equal(s.calls.decode.length, stage === "chunk" ? 1 : 0);
    assert.deepEqual(s.calls.appended, []);
  });
}

test("a refusal landing after the preview ended never reaches a later dictation", async (t) => {
  const refusal = deferred();
  const s = scenario(t, {
    online: true,
    stream: {
      sendPcm16() {},
      finish: async () => ({ text: "", truncated: false }),
      abort() {},
    },
  });
  const manager = s.parakeet;
  manager.createOnlineStream = () => refusal.promise;

  const starting = s.start("online-model");
  await s.invoke("hide-dictation-preview");
  refusal.resolve(Promise.reject(blockedModel()));
  await starting;

  assert.deepEqual(await s.invoke("stop-dictation-preview"), {
    success: true,
    streamed: false,
    text: "",
  });
});

test("a preview refusal is reported by one stop only", async (t) => {
  const s = scenario(t, { online: true, stream: blockedModel() });
  await s.start("online-model");

  assert.equal((await s.invoke("stop-dictation-preview")).code, blockedModel().code);
  assert.deepEqual(await s.invoke("stop-dictation-preview"), {
    success: true,
    streamed: false,
    text: "",
  });
});

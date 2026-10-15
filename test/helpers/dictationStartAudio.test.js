const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const { EventEmitter } = require("node:events");
const WS = require("ws");

// Exercise the registered IPC handlers and real realtime client; only token
// minting and the provider socket are replaced. No provider requests are made.

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

Module._load = function loadElectron(request, parent, isMain) {
  if (request === "electron") return electronStub;
  return originalLoad.call(this, request, parent, isMain);
};
const OpenAIRealtimeStreaming = require("../../src/helpers/openaiRealtimeStreaming");
let connectionGate = null;
const instances = [];
class LoopbackRealtime extends OpenAIRealtimeStreaming {
  constructor() {
    super();
    instances.push(this);
  }
  async connect(options) {
    const socket = new EventEmitter();
    socket.readyState = WS.CONNECTING;
    socket.audio = [];
    socket.send = (raw) => {
      const event = JSON.parse(raw);
      if (event.type === "input_audio_buffer.append") {
        socket.audio.push(Buffer.from(event.audio, "base64"));
      }
      if (event.type === "input_audio_buffer.commit") {
        setImmediate(() =>
          socket.emit(
            "message",
            JSON.stringify({
              type: "conversation.item.input_audio_transcription.completed",
              transcript: "",
            })
          )
        );
      }
    };
    socket.ping = () => socket.emit("pong");
    socket.close = () => {
      socket.readyState = WS.CLOSED;
    };
    this.testSocket = socket;
    return super.connect({
      ...options,
      createSocket: async () => {
        await connectionGate?.promise;
        setImmediate(() => {
          if (socket.readyState === WS.CLOSED) return;
          socket.readyState = WS.OPEN;
          socket.emit("message", JSON.stringify({ type: "session.created" }));
          socket.emit("message", JSON.stringify({ type: "session.updated" }));
        });
        return socket;
      },
    });
  }
}
Module._load = function loadWithMocks(request, parent, isMain) {
  if (request === "electron") return electronStub;
  if (parent?.filename === handlersModulePath) {
    if (request === "./debugLogger") return new Proxy({}, { get: () => () => {} });
    if (request === "./openaiRealtimeStreaming") return LoopbackRealtime;
    if (request === "./realtimeTokenProviders") {
      return {
        ...originalLoad.call(this, request, parent, isMain),
        fetchRealtimeTokenForProvider: async () => "secret",
      };
    }
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
function scenario(t) {
  instances.length = 0;
  connectionGate = null;
  const target = {
    _dictationStreaming: null,
    _dictationConnectPromise: null,
    _dictationIdleTimer: null,
    _dictationPreviewEnabled: false,
    windowManager: { hideTranscriptionPreview() {}, showTranscriptionPreview() {} },
  };
  require(handlersModulePath).prototype.setupHandlers.call(
    new Proxy(target, {
      get: (value, property) => (property in value ? value[property] : anything()),
    })
  );
  const event = { sender: { send() {} } };
  const invoke = (channel, options) =>
    handlers.get(`dictation-realtime-${channel}`)(event, options);
  t.after(() => {
    clearTimeout(target._dictationIdleTimer);
    for (const streaming of instances) streaming.cleanup();
  });
  return {
    invoke,
    send: (frame) => listeners.get("dictation-realtime-send")(event, frame),
    target,
  };
}
const optionsFor = (provider) => ({
  provider,
  mode: "byok",
  model: provider === "tinfoil-realtime" ? "voxtral-mini-4b-realtime" : "gpt-4o-mini-transcribe",
});
const deferConnection = () => {
  connectionGate = Promise.withResolvers();
  return connectionGate;
};
const received = (streaming) => Buffer.concat(streaming.testSocket.audio);
const frames = (seconds) =>
  Array.from({ length: seconds }, (_, index) => Buffer.alloc(16000 * 2, index + 1));
// OpenAI upsamples 16kHz PCM; use constant signed PCM samples so byte identity
// remains checkable after its 24kHz conversion.
const expectedAudio = (provider, chunks) =>
  Buffer.concat(
    chunks.map((frame) =>
      provider === "tinfoil-realtime" ? frame : Buffer.alloc(frame.length * 1.5, frame[0])
    )
  );

for (const provider of ["openai-realtime", "tinfoil-realtime"]) {
  for (const existing of ["cold", "warm", "different model", "unfinished warmup"]) {
    test(`${provider} preserves five seconds of startup audio (${existing})`, async (t) => {
      const s = scenario(t);
      const options = optionsFor(provider);
      let warmup;
      let oldGate;
      if (existing === "unfinished warmup") oldGate = deferConnection();
      if (existing !== "cold") {
        warmup = s.invoke(
          "warmup",
          existing === "warm" ? options : { ...options, model: "previous-model" }
        );
        if (existing === "unfinished warmup") await new Promise(setImmediate);
        else await warmup;
      }
      const gate = existing === "warm" ? null : deferConnection();
      const started = s.invoke("start", options);
      const audio = frames(5);
      for (const frame of audio) s.send(frame);
      oldGate?.resolve();
      if (warmup) await warmup;
      gate?.resolve();
      assert.equal((await started).success, true);
      const current = instances.at(-1);
      assert.equal(
        received(current).equals(expectedAudio(provider, audio)),
        true,
        `received ${received(current).length} bytes`
      );
      if (instances.length > 1) assert.equal(received(instances[0]).length, 0);
      const live = Buffer.alloc(3200, 7);
      s.send(live);
      assert.equal(received(current).equals(expectedAudio(provider, [...audio, live])), true);
    });
  }

  test(`${provider} fails explicitly instead of silently truncating a full startup queue`, async (t) => {
    const s = scenario(t);
    const gate = deferConnection();
    const started = s.invoke("start", optionsFor(provider));
    for (const frame of frames(31)) s.send(frame);
    gate.resolve();
    const result = await started;
    assert.equal(result.success, false);
    assert.match(result.error, /audio.*buffer|buffer.*audio/i);
    assert.equal(received(instances.at(-1)).length, 0);
    assert.equal(s.target._dictationStreaming, null);
    connectionGate = null;
    assert.equal((await s.invoke("start", optionsFor(provider))).success, true);
    const live = Buffer.alloc(3200, 7);
    s.send(live);
    assert.equal(received(instances.at(-1)).equals(expectedAudio(provider, [live])), true);
  });

  test(`${provider} discards queued audio after connection failure`, async (t) => {
    const s = scenario(t);
    const gate = deferConnection();
    const started = s.invoke("start", optionsFor(provider));
    s.send(Buffer.alloc(3200, 1));
    await new Promise(setImmediate);
    gate.reject(new Error("connection failed"));
    assert.equal((await started).success, false);
    connectionGate = null;
    assert.equal((await s.invoke("start", optionsFor(provider))).success, true);
    assert.equal(received(instances.at(-1)).length, 0);
  });

  test(`${provider} timeout clears startup audio and closes a late socket`, async (t) => {
    const s = scenario(t);
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const gate = deferConnection();
    const started = s.invoke("start", optionsFor(provider));
    for (const frame of frames(5)) s.send(frame);
    await new Promise(setImmediate);
    t.mock.timers.tick(15000);
    assert.equal((await started).success, false);
    gate.resolve();
    await new Promise(setImmediate);
    const failed = instances.at(-1);
    assert.equal(failed.testSocket.readyState, WS.CLOSED);
    assert.equal(received(failed).length, 0);
    connectionGate = null;
    assert.equal((await s.invoke("start", optionsFor(provider))).success, true);
    assert.equal(received(instances.at(-1)).length, 0);
  });

  test(`${provider} stop during startup cannot replay audio after the connection finishes`, async (t) => {
    const s = scenario(t);
    const gate = deferConnection();
    const started = s.invoke("start", optionsFor(provider));
    s.send(Buffer.alloc(3200, 1));
    await new Promise(setImmediate);
    assert.equal((await s.invoke("stop")).success, true);
    gate.resolve();
    assert.equal((await started).success, false);
    assert.equal(received(instances.at(-1)).length, 0);
    assert.equal(instances.at(-1).testSocket.readyState, WS.CLOSED);
  });
}

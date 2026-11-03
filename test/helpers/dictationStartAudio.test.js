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
// How the provider answers a commit; the default settles the turn at once.
let answerCommit = null;
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
    socket.commits = 0;
    socket.send = (raw) => {
      const event = JSON.parse(raw);
      if (event.type === "input_audio_buffer.append") {
        socket.audio.push(Buffer.from(event.audio, "base64"));
      }
      if (event.type === "input_audio_buffer.commit") {
        socket.commits += 1;
        if (answerCommit) return answerCommit(socket);
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
  answerCommit = null;
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
const settle = async () => {
  for (let turn = 0; turn < 5; turn += 1) await new Promise(setImmediate);
};
// Resolves to "pending" if the promise has not settled within a few turns.
const settledSoon = (promise) => Promise.race([promise, settle().then(() => "pending")]);
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
    await settle();
    assert.equal(received(instances.at(-1)).length, 0);
    assert.equal(instances.at(-1).testSocket.readyState, WS.CLOSED);
  });

  test(`${provider} a queued re-warm never retires the session a start claimed`, async (t) => {
    const s = scenario(t);
    const options = optionsFor(provider);
    const previous = { ...options, model: "previous-model" };
    const gate = deferConnection();
    // Both post-dictation re-warms fire together and queue one behind another.
    const warmups = [s.invoke("warmup", previous), s.invoke("warmup", previous)];
    await new Promise(setImmediate);
    const started = s.invoke("start", options);
    const audio = frames(5);
    for (const frame of audio) s.send(frame);
    gate.resolve();
    assert.equal((await started).success, true);
    await Promise.all(warmups);
    const current = s.target._dictationStreaming;
    assert.notEqual(current.testSocket.readyState, WS.CLOSED);
    const live = Buffer.alloc(3200, 7);
    s.send(live);
    assert.equal(
      received(current).equals(expectedAudio(provider, [...audio, live])),
      true,
      `the live session holds ${received(current).length} bytes`
    );
    assert.equal(s.target._dictationIdleTimer, null, "a claimed session has no idle timer");
  });

  test(`${provider} cancel during a slow connect sends nothing and never commits`, async (t) => {
    const s = scenario(t);
    const gate = deferConnection();
    const started = s.invoke("start", optionsFor(provider));
    for (const frame of frames(5)) s.send(frame);
    await new Promise(setImmediate);
    assert.equal((await s.invoke("cancel")).success, true);
    const result = await settledSoon(started);
    assert.notEqual(result, "pending", "the start settles as soon as it is cancelled");
    assert.equal(result.success, false);
    gate.resolve();
    await settle();
    const session = instances.at(-1);
    assert.equal(received(session).length, 0);
    assert.equal(session.testSocket.commits, 0);
    assert.equal(session.testSocket.readyState, WS.CLOSED);
    assert.equal(s.target._dictationStreaming, null);
  });

  test(`${provider} cancel of a connected recording closes it without a commit`, async (t) => {
    const s = scenario(t);
    assert.equal((await s.invoke("start", optionsFor(provider))).success, true);
    const session = s.target._dictationStreaming;
    s.send(Buffer.alloc(3200, 7));
    assert.equal((await s.invoke("cancel")).success, true);
    await settle();
    assert.equal(session.testSocket.commits, 0);
    assert.equal(session.testSocket.readyState, WS.CLOSED);
    assert.equal(s.target._dictationStreaming, null);
  });

  test(`${provider} a full startup queue fails the start at once with a coded error`, async (t) => {
    const s = scenario(t);
    const gate = deferConnection();
    const started = s.invoke("start", optionsFor(provider));
    for (const frame of frames(31)) s.send(frame);
    const result = await settledSoon(started);
    assert.notEqual(result, "pending", "the start fails as soon as its queue fills");
    assert.equal(result.success, false);
    assert.equal(result.code, "REALTIME_START_AUDIO_OVERFLOW");
    assert.equal(result.messageKey, "streaming.errors.slowStart.description");
    // The renderer keeps sending until it learns of the failure.
    s.send(Buffer.alloc(3200, 9));
    gate.resolve();
    await settle();
    const abandoned = instances.at(-1);
    assert.equal(received(abandoned).length, 0);
    assert.equal(abandoned.testSocket.commits, 0);
    assert.equal(abandoned.testSocket.readyState, WS.CLOSED);
    assert.equal(s.target._dictationStreaming, null);
    // The next recording streams normally.
    connectionGate = null;
    assert.equal((await s.invoke("start", optionsFor(provider))).success, true);
    const live = Buffer.alloc(3200, 7);
    s.send(live);
    assert.equal(received(instances.at(-1)).equals(expectedAudio(provider, [live])), true);
  });

  test(`${provider} a stop that runs out of time with a turn pending reports it incomplete`, async (t) => {
    const s = scenario(t);
    t.mock.timers.enable({ apis: ["setTimeout"] });
    assert.equal((await s.invoke("start", optionsFor(provider))).success, true);
    s.send(Buffer.alloc(3200, 7));
    // OpenAI acknowledges the commit but the turn never finishes; Tinfoil,
    // which never acknowledges commits, sends nothing at all.
    answerCommit = (socket) => {
      if (provider === "tinfoil-realtime") return;
      setImmediate(() =>
        socket.emit(
          "message",
          JSON.stringify({ type: "input_audio_buffer.committed", item_id: "last" })
        )
      );
    };
    const stopping = s.invoke("stop");
    await settle();
    t.mock.timers.tick(3000);
    const result = await stopping;
    assert.equal(result.success, true);
    assert.equal(result.incomplete, true);
  });

  test(`${provider} a stop whose turns all finish is not marked incomplete`, async (t) => {
    const s = scenario(t);
    assert.equal((await s.invoke("start", optionsFor(provider))).success, true);
    s.send(Buffer.alloc(3200, 7));
    const result = await s.invoke("stop");
    assert.equal(result.success, true);
    assert.equal(result.incomplete, undefined);
  });

  test(`${provider} audio sent before the start reaches the redialed session`, async (t) => {
    const s = scenario(t);
    const options = optionsFor(provider);
    const oldGate = deferConnection();
    const warmup = s.invoke("warmup", { ...options, model: "previous-model" });
    await new Promise(setImmediate);
    // The worklet is wired before the start call, so its first frames land in
    // the unfinished warmup's cold-start buffer.
    const early = frames(1);
    s.send(early[0]);
    const gate = deferConnection();
    const started = s.invoke("start", options);
    const audio = frames(3);
    for (const frame of audio) s.send(frame);
    oldGate.resolve();
    await warmup;
    gate.resolve();
    assert.equal((await started).success, true);
    const current = instances.at(-1);
    const live = Buffer.alloc(3200, 7);
    s.send(live);
    assert.equal(
      received(current).equals(expectedAudio(provider, [...early, ...audio, live])),
      true,
      `received ${received(current).length} bytes`
    );
    assert.equal(received(instances[0]).length, 0);
  });

  test(`${provider} a concurrent start is refused with a code`, async (t) => {
    const s = scenario(t);
    const gate = deferConnection();
    const first = s.invoke("start", optionsFor(provider));
    const second = await s.invoke("start", optionsFor(provider));
    assert.equal(second.success, false);
    assert.equal(second.code, "OPERATION_IN_PROGRESS");
    gate.resolve();
    assert.equal((await first).success, true);
  });

  for (const ending of ["cancel", "overflow"]) {
    test(`${provider} ${ending} while a re-warm is still dialling leaves no socket open`, async (t) => {
      const s = scenario(t);
      const options = optionsFor(provider);
      // The re-warm is building its socket, so its session has none to close yet.
      const gate = deferConnection();
      const warmup = s.invoke("warmup", { ...options, model: "previous-model" });
      await new Promise(setImmediate);
      const started = s.invoke("start", options);
      if (ending === "cancel") await s.invoke("cancel");
      else for (const frame of frames(31)) s.send(frame);
      assert.equal((await started).success, false);
      gate.resolve();
      await warmup;
      await settle();
      const warmed = instances[0];
      assert.equal(warmed.isConnected, false, "the re-warm's late socket is still connected");
      assert.equal(warmed.testSocket.readyState, WS.CLOSED);
      assert.equal(s.target._dictationStreaming, null);
    });
  }
}

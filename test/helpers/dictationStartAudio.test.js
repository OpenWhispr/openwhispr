const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const { EventEmitter } = require("node:events");
const vm = require("node:vm");
const WS = require("ws");
const { loadAudioManager } = require("./harness/audioManager");
const { installMicCaptureGlobals } = require("../lib/rendererTestHarness");

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
    static fromWebContents(sender) {
      return { isDestroyed: () => false, webContents: sender };
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
let tokenGate = null;
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
        socket.audioAtCommit = Buffer.concat(socket.audio);
        socket.commits++;
        setImmediate(() =>
          socket.emit(
            "message",
            JSON.stringify({
              type: "conversation.item.input_audio_transcription.completed",
              transcript: "Opening words retained.",
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
const geminiSockets = [];
class ControlledGeminiSocket extends EventEmitter {
  constructor() {
    super();
    this.readyState = WS.CONNECTING;
    this.audio = [];
    this.commits = 0;
    geminiSockets.push(this);
    setImmediate(() => {
      this.readyState = WS.OPEN;
      this.emit("open");
    });
  }
  send(raw) {
    const message = JSON.parse(raw);
    if (message.setup) {
      Promise.resolve(connectionGate?.promise).then(
        () => this.emit("message", JSON.stringify({ setupComplete: {} })),
        (error) => this.emit("error", error)
      );
    }
    if (message.realtimeInput?.audio) {
      this.audio.push(Buffer.from(message.realtimeInput.audio.data, "base64"));
    }
    if (message.realtimeInput?.audioStreamEnd) {
      this.audioAtCommit = Buffer.concat(this.audio);
      this.commits++;
      setImmediate(() =>
        this.emit(
          "message",
          JSON.stringify({
            serverContent: {
              inputTranscription: { text: "Opening words retained." },
              generationComplete: true,
            },
          })
        )
      );
    }
  }
  close() {
    this.readyState = WS.CLOSED;
  }
  terminate() {
    this.close();
  }
}
Object.assign(ControlledGeminiSocket, {
  OPEN: WS.OPEN,
  CLOSED: WS.CLOSED,
  CONNECTING: WS.CONNECTING,
});
Module._load = function loadWithMocks(request, parent, isMain) {
  if (request === "ws" && parent?.filename.endsWith("/geminiLiveStreaming.js")) {
    return ControlledGeminiSocket;
  }
  if (request === "electron") return electronStub;
  if (parent?.filename === handlersModulePath) {
    if (request === "./debugLogger") return new Proxy({}, { get: () => () => {} });
    if (request === "./openaiRealtimeStreaming") return LoopbackRealtime;
    if (request === "./realtimeTokenProviders") {
      return {
        ...originalLoad.call(this, request, parent, isMain),
        fetchRealtimeTokenForProvider: async () => {
          await tokenGate?.promise;
          return "test-token";
        },
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
function scenario(t, prefix = "dictation-realtime") {
  instances.length = 0;
  geminiSockets.length = 0;
  connectionGate = null;
  tokenGate = null;
  const target = {
    geminiStreaming: null,
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
  const delivered = new EventEmitter();
  const event = { sender: { send: (channel, data) => delivered.emit(channel, data) } };
  const invoke = (channel, options) => handlers.get(`${prefix}-${channel}`)(event, options);
  t.after(() => {
    clearTimeout(target._dictationIdleTimer);
    for (const streaming of instances) streaming.cleanup();
    target.geminiStreaming?.cleanup();
  });
  return {
    invoke,
    delivered,
    cancelPendingStart: () => listeners.get(`${prefix}-cancel-pending-start`)?.(event),
    send: (frame) => listeners.get(`${prefix}-send`)(event, frame),
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

// Run the actual renderer start/cancel/stop and provider adapter against the
// registered handlers above; only microphone hardware and network are faked.
async function rendererScenario(t, s, provider) {
  const { AudioManager, window } = await loadAudioManager(t, {
    cachePrefix: "openwhispr-start-cancellation-",
    settingsKey: "__startCancellationSettings",
    settings: {
      useLocalWhisper: false,
      transcriptionMode: "providers",
      cloudTranscriptionMode: "byok",
      cloudTranscriptionProvider: provider === "tinfoil-realtime" ? "tinfoil" : "openai",
    },
  });
  installMicCaptureGlobals(t);
  const FakeAudioWorkletNode = globalThis.AudioWorkletNode;
  globalThis.AudioWorkletNode = class extends FakeAudioWorkletNode {
    constructor(...args) {
      super(...args);
      this.port.postMessage = (data) => {
        if (data === "stop") queueMicrotask(() => this.port.onmessage?.({ data: "flushed" }));
      };
    }
  };
  window.dispatchEvent = () => true;
  const calls = [];
  const listen = (channel) => (callback) => {
    s.delivered.on(channel, callback);
    return () => s.delivered.off(channel, callback);
  };
  Object.assign(window.electronAPI, {
    dictationRealtimeStart: (options) => {
      calls.push("start");
      return s.invoke("start", options);
    },
    dictationRealtimeSend: s.send,
    dictationRealtimeCancelPendingStart: () => {
      calls.push("discard");
      s.cancelPendingStart();
    },
    dictationRealtimeStop: () => {
      calls.push("stop");
      return s.invoke("stop");
    },
    onDictationRealtimePartial: listen("dictation-realtime-partial"),
    onDictationRealtimeFinal: listen("dictation-realtime-final"),
    onDictationRealtimeError: listen("dictation-realtime-error"),
    onDictationRealtimeSessionEnd: listen("dictation-realtime-session-end"),
  });
  if (provider === "gemini") {
    Object.assign(window.electronAPI, {
      geminiStreamingStart: window.electronAPI.dictationRealtimeStart,
      geminiStreamingSend: s.send,
      geminiStreamingCancelPendingStart: window.electronAPI.dictationRealtimeCancelPendingStart,
      geminiStreamingStop: window.electronAPI.dictationRealtimeStop,
      geminiStreamingFinalize: () => listeners.get("gemini-streaming-finalize")(),
      onGeminiPartialTranscript: listen("gemini-partial-transcript"),
      onGeminiFinalTranscript: listen("gemini-final-transcript"),
      onGeminiError: listen("gemini-error"),
      onGeminiSessionEnd: listen("gemini-session-end"),
    });
  }
  const completions = [];
  const errors = [];
  const manager = Object.assign(Object.create(AudioManager.prototype), {
    isRecording: false,
    isProcessing: false,
    isStreaming: false,
    streamingStartInProgress: false,
    _streamingStartSettlementWaiters: [],
    stopRequestedDuringStreamingStart: false,
    _streamingStopPromise: null,
    _streamingStopMode: null,
    _streamingCancellationGeneration: 0,
    _streamingSessionGeneration: 0,
    _activeStreamingSessionId: null,
    _streamingMicSwapPromise: null,
    streamingCleanupFns: [],
    streamingFallbackChunks: [],
    _streamingFallbackSegments: [],
    preparedMicCapture: { take: async () => null, cancel() {} },
    micRecovery: { stop() {} },
    isRecordingAllowedByPolicy: () => true,
    getAudioConstraints: async () => ({}),
    _acquireCaptureStream: () => navigator.mediaDevices.getUserMedia(),
    getOrCreateAudioContext: async () => new globalThis.AudioContext(),
    getWorkletBlobUrl: () => "",
    getStreamingProviderName: () => provider,
    getEffectiveSttLanguage: () => "auto",
    getKeyterms: () => [],
    beginMicRecovery: async () => {},
    startStreamingFallbackRecorder() {},
    finishStreamingFallbackSegment: async () => null,
    mergeRecordedSegments: async () => null,
    getLargestRecordedSegment: () => null,
    awaitStreamingTextSettled: async () => {},
    cleanupPreview: async () => {},
    finalizeChineseScript: async (text) => text,
    _markCaptureStreamReleased() {},
    onStateChange() {},
    onError: (error) => errors.push(error),
    onTranscriptionComplete: (result) => completions.push(result),
  });
  return { manager, calls, completions, errors };
}

for (const provider of ["openai-realtime", "tinfoil-realtime"]) {
  for (const phase of ["socket factory", "token", "different warm model", "stop then cancel"]) {
    test(`${provider} renderer Cancel discards 84800 held bytes (${phase})`, async (t) => {
      const s = scenario(t);
      if (phase === "different warm model") {
        await s.invoke("warmup", { ...optionsFor(provider), model: "previous-model" });
      }
      const gate = phase === "token" ? (tokenGate = Promise.withResolvers()) : deferConnection();
      const r = await rendererScenario(t, s, provider);
      const started = r.manager.startStreamingRecording();
      while (!r.calls.includes("start")) await new Promise(setImmediate);
      s.send(Buffer.alloc(84800, 1));
      if (phase === "stop then cancel") await r.manager.stopStreamingRecording();
      const cancelled = r.manager.cancelStreamingRecording();
      const duplicate = r.manager.cancelStreamingRecording();
      const callsBeforeReadiness = [...r.calls];
      assert.equal(r.manager.isProcessing, true);
      assert.equal(await r.manager.startStreamingRecording(), false);
      s.send(Buffer.alloc(3200, 2)); // already queued IPC after capture cleanup
      gate.resolve();
      assert.deepEqual(await Promise.all([started, cancelled, duplicate]), [false, true, true]);
      const current = instances.at(-1);
      assert.equal(received(current).length, 0, "cancelled startup must transmit zero bytes");
      assert.deepEqual(callsBeforeReadiness, ["start", "discard"]);
      assert.equal(current.testSocket.commits, 0);
      assert.equal(current.testSocket.readyState, WS.CLOSED);
      assert.deepEqual(r.completions, []);
      assert.deepEqual(r.errors, []);
      assert.equal(r.manager.isProcessing, false);
      assert.equal(r.manager.streamingStartInProgress, false);
      assert.equal(r.manager.streamingStream ?? null, null);
      assert.deepEqual(r.calls, ["start", "discard", "stop"]);
      // Idle discard cannot poison or disconnect the next recording.
      s.cancelPendingStart();
      assert.equal(await r.manager.startStreamingRecording(), true);
      s.send(Buffer.alloc(3200, 3));
      assert.ok(
        received(instances.at(-1)).equals(expectedAudio(provider, [Buffer.alloc(3200, 3)]))
      );
      await r.manager.cancelStreamingRecording();
    });
  }

  test(`${provider} renderer Stop preserves held bytes and delivers one transcript`, async (t) => {
    const s = scenario(t);
    const gate = deferConnection();
    const r = await rendererScenario(t, s, provider);
    const started = r.manager.startStreamingRecording();
    while (!r.calls.includes("start")) await new Promise(setImmediate);
    const audio = [Buffer.alloc(42400, 1), Buffer.alloc(42400, 2)];
    audio.forEach(s.send);
    assert.equal(await r.manager.stopStreamingRecording(), true);
    assert.deepEqual(r.calls, ["start"]);
    gate.resolve();
    assert.equal(await started, true);
    const current = instances.at(-1);
    assert.ok(received(current).equals(expectedAudio(provider, audio)));
    assert.equal(current.testSocket.commits, 1);
    assert.equal(current.testSocket.readyState, WS.CLOSED);
    assert.equal(r.completions.length, 1);
    assert.equal(r.completions[0].text, "Opening words retained.");
    assert.deepEqual(r.errors, []);
    assert.deepEqual(r.calls, ["start", "stop"]);
  });
}

for (const phase of ["handshake", "token", "different warm model", "stop then cancel", "stop"]) {
  test(`Gemini renderer startup ${phase} preserves Stop and discards Cancel`, async (t) => {
    const s = scenario(t, "gemini-streaming");
    if (phase === "different warm model") {
      await s.invoke("warmup", { mode: "byok", model: "gemini-previous-model" });
    }
    const gate = phase === "token" ? (tokenGate = Promise.withResolvers()) : deferConnection();
    const r = await rendererScenario(t, s, "gemini");
    const started = r.manager.startStreamingRecording();
    while (!r.calls.includes("start")) await new Promise(setImmediate);
    const audio = [Buffer.alloc(42400, 1), Buffer.alloc(42400, 2)];
    audio.forEach(s.send);
    if (phase === "stop" || phase === "stop then cancel") await r.manager.stopStreamingRecording();
    const cancelled = phase === "stop" ? null : r.manager.cancelStreamingRecording();
    const duplicate = phase === "stop" ? null : r.manager.cancelStreamingRecording();
    if (cancelled) {
      assert.equal(r.manager.isProcessing, true);
      s.send(Buffer.alloc(3200, 3));
    }
    gate.resolve();
    const results = await Promise.all([started, cancelled, duplicate]);
    const socket = geminiSockets.at(-1);
    assert.equal(socket.readyState, WS.CLOSED);
    assert.deepEqual(r.errors, []);
    assert.equal(r.manager.isProcessing, false);
    assert.equal(r.manager.streamingStream ?? null, null);
    if (cancelled) {
      assert.deepEqual(results, [false, true, true]);
      assert.equal(Buffer.concat(socket.audio).length, 0);
      assert.equal(socket.commits, 0);
      assert.deepEqual(r.completions, []);
      assert.deepEqual(r.calls, ["start", "discard", "stop"]);
      s.cancelPendingStart();
      assert.equal(await r.manager.startStreamingRecording(), true);
      s.send(Buffer.alloc(3200, 4));
      assert.ok(Buffer.concat(geminiSockets.at(-1).audio).equals(Buffer.alloc(3200, 4)));
      await r.manager.cancelStreamingRecording();
    } else {
      assert.equal(results[0], true);
      assert.ok(Buffer.concat(socket.audio).equals(Buffer.concat(audio)));
      assert.equal(socket.commits, 1);
      assert.equal(r.completions.length, 1);
      assert.equal(r.completions[0].text, "Opening words retained.");
      assert.deepEqual(r.calls, ["start", "stop"]);
    }
  });
}

for (const provider of ["openai-realtime", "tinfoil-realtime", "gemini"]) {
  test(`${provider} cancellation followed by token failure stays quiet and permits retry`, async (t) => {
    const s = scenario(t, provider === "gemini" ? "gemini-streaming" : "dictation-realtime");
    const r = await rendererScenario(t, s, provider);
    const gate = (tokenGate = Promise.withResolvers());
    const started = r.manager.startStreamingRecording();
    while (!r.calls.includes("start")) await new Promise(setImmediate);
    s.send(Buffer.alloc(84800, 1));
    const cancelled = r.manager.cancelStreamingRecording();
    gate.reject(new Error("test token unavailable"));
    assert.deepEqual(await Promise.all([started, cancelled]), [false, true]);
    assert.deepEqual(r.errors, []);
    assert.deepEqual(r.completions, []);
    assert.equal(r.manager.isProcessing, false);
    tokenGate = null;
    assert.equal(await r.manager.startStreamingRecording(), true);
    s.send(Buffer.alloc(3200, 5));
    const audio =
      provider === "gemini"
        ? Buffer.concat(geminiSockets.at(-1).audio)
        : received(instances.at(-1));
    assert.ok(
      audio.equals(
        expectedAudio(provider === "gemini" ? "tinfoil-realtime" : provider, [
          Buffer.alloc(3200, 5),
        ])
      )
    );
    await r.manager.cancelStreamingRecording();
  });
}

for (const provider of ["openai-realtime", "tinfoil-realtime", "gemini"]) {
  test(`${provider} cancelled startup timeout closes the late socket and permits retry`, async (t) => {
    const s = scenario(t, provider === "gemini" ? "gemini-streaming" : "dictation-realtime");
    const r = await rendererScenario(t, s, provider);
    const gate = deferConnection();
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const started = r.manager.startStreamingRecording();
    while (!r.calls.includes("start")) await new Promise(setImmediate);
    await new Promise(setImmediate);
    s.send(Buffer.alloc(84800, 1));
    const cancelled = r.manager.cancelStreamingRecording();
    t.mock.timers.tick(15000);
    assert.deepEqual(await Promise.all([started, cancelled]), [false, true]);
    gate.resolve();
    await new Promise(setImmediate);
    const socket = provider === "gemini" ? geminiSockets.at(-1) : instances.at(-1).testSocket;
    assert.equal(socket.readyState, WS.CLOSED);
    assert.equal(Buffer.concat(socket.audio).length, 0);
    assert.equal(socket.commits, 0);
    assert.deepEqual(r.errors, []);
    assert.deepEqual(r.completions, []);
    t.mock.timers.reset();
    assert.equal(await r.manager.startStreamingRecording(), true);
    await r.manager.cancelStreamingRecording();
  });
}

// Run the actual embedded processor, with a controllable MessagePort queue.
// Its process() input represents acquisition time; delayed port delivery is
// intentionally separate so a Stop must retain queued pre-Stop PCM.
async function installRealStreamingWorklet(t, manager) {
  delete manager.getWorkletBlobUrl;
  const url = manager.getWorkletBlobUrl();
  const source = await (await fetch(url)).text();
  t.after(() => URL.revokeObjectURL(url));
  let Processor;
  let node;
  let holdMessages = true;
  const messages = [];
  const deliver = (data) => node.port.onmessage?.({ data });
  vm.runInNewContext(source, {
    Int16Array,
    AudioWorkletProcessor: class {
      constructor() {
        this.port = {
          postMessage(data) {
            if (holdMessages) messages.push(data);
            else queueMicrotask(() => deliver(data));
          },
        };
      }
    },
    registerProcessor: (_name, implementation) => {
      Processor = implementation;
    },
  });
  globalThis.AudioWorkletNode = class {
    constructor() {
      node = this;
      this.processor = new Processor();
      this.port = {
        onmessage: null,
        postMessage: (data) => this.processor.port.onmessage({ data }),
      };
    }
    connect() {}
    disconnect() {}
  };
  return {
    process: (samples, marker) =>
      node.processor.process([[new Float32Array(samples).fill((marker * 257 + 0.5) / 32767)]]),
    deliverQueued() {
      while (messages.length) deliver(messages.shift());
    },
    releaseQueue() {
      this.deliverQueued();
      holdMessages = false;
    },
  };
}

for (const provider of ["openai-realtime", "tinfoil-realtime", "gemini"]) {
  for (const delayMs of [5000, 10000]) {
    test(`${provider} Stop freezes real worklet capture during ${delayMs}ms startup`, async (t) => {
      const s = scenario(t, provider === "gemini" ? "gemini-streaming" : "dictation-realtime");
      const gate = deferConnection();
      const r = await rendererScenario(t, s, provider);
      const worklet = await installRealStreamingWorklet(t, r.manager);
      let trackStops = 0;
      let sourceDisconnects = 0;
      const getContext = r.manager.getOrCreateAudioContext;
      r.manager.getOrCreateAudioContext = async () => {
        const context = await getContext();
        const createSource = context.createMediaStreamSource.bind(context);
        context.createMediaStreamSource = (...args) => {
          const source = createSource(...args);
          source.disconnect = () => {
            sourceDisconnects++;
          };
          return source;
        };
        return context;
      };
      const acquire = navigator.mediaDevices.getUserMedia;
      navigator.mediaDevices.getUserMedia = async () => {
        const stream = await acquire();
        stream.getTracks()[0].stop = () => {
          trackStops++;
        };
        return stream;
      };
      t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() });
      const started = r.manager.startStreamingRecording();
      while (!r.calls.includes("start")) await new Promise(setImmediate);
      const chunks = [];
      for (let marker = 1; marker <= 53; marker++) {
        worklet.process(800, marker);
        chunks.push(Buffer.alloc(1600, marker));
        if (marker < 53) worklet.deliverQueued();
      }
      // One full frame is still queued, and a partial frame is inside the
      // processor. Both belong to this recording even though delivered later.
      worklet.process(134, 54);
      chunks.push(Buffer.alloc(268, 54));
      t.mock.timers.tick(2650);
      const stopped = r.manager.stopStreamingRecording();
      const duplicateStop = r.manager.stopStreamingRecording();
      await new Promise(setImmediate);
      const trackStopsBeforeReady = trackStops;
      const sourceDisconnectsBeforeReady = sourceDisconnects;
      const port = r.manager.streamingProcessor?.port;
      const acceptedAfterStop = worklet.process(1600, 99);
      worklet.releaseQueue();
      port?.onmessage?.({ data: Buffer.alloc(3200, 100) });
      assert.equal(
        await r.manager.startStreamingRecording(),
        false,
        "restart waits for finalization"
      );
      t.mock.timers.tick(delayMs - 2650);
      t.mock.timers.reset();
      gate.resolve();
      await Promise.all([started, stopped, duplicateStop]);
      const socket = provider === "gemini" ? geminiSockets.at(-1) : instances.at(-1).testSocket;
      const expected = expectedAudio(provider === "gemini" ? "tinfoil-realtime" : provider, chunks);
      assert.equal(socket.commits, 1);
      assert.equal(r.completions.length, 1);
      assert.equal(r.completions[0].text, "Opening words retained.");
      assert.equal(socket.readyState, WS.CLOSED);
      assert.deepEqual(r.errors, []);
      assert.deepEqual(
        Buffer.concat(socket.audio),
        expected,
        "retain queued frames and partial tail only"
      );
      assert.deepEqual(socket.audioAtCommit, expected, "commit follows every preserved sample");
      assert.equal(acceptedAfterStop, false, "the real worklet cannot acquire post-Stop input");
      assert.equal(trackStopsBeforeReady, 1, "release microphone before network readiness");
      assert.ok(sourceDisconnectsBeforeReady > 0, "disconnect capture source before readiness");
      assert.equal(
        r.manager.lastAudioMetadata.durationMs,
        2650,
        "duration excludes readiness wait"
      );
      assert.equal(r.manager.streamingStream ?? null, null);
      assert.equal(r.manager.isProcessing, false);
      assert.equal(await r.manager.startStreamingRecording(), true, "next session may now start");
      await r.manager.cancelStreamingRecording();
    });
  }
}

for (const phase of [
  "activation",
  "microphone",
  "audio context",
  "worklet module",
  "mic recovery",
]) {
  test(`Stop while ${phase} setup is pending releases late capture without reconnecting`, async (t) => {
    const s = scenario(t);
    const r = await rendererScenario(t, s, "tinfoil-realtime");
    const worklet = await installRealStreamingWorklet(t, r.manager);
    const gate = Promise.withResolvers();
    const entered = Promise.withResolvers();
    let stopped = false;
    let trackStops = 0;
    let connectionsAfterStop = 0;
    let recoveryActive = false;
    if (phase === "activation") {
      r.manager._beginActivationCapture = async () => {
        entered.resolve();
        await gate.promise;
        return true;
      };
    }
    const acquire = navigator.mediaDevices.getUserMedia;
    r.manager._acquireCaptureStream = async () => {
      const stream = await acquire();
      stream.getTracks()[0].stop = () => {
        trackStops++;
      };
      if (phase === "microphone") {
        entered.resolve();
        await gate.promise;
      }
      return stream;
    };
    r.manager.getOrCreateAudioContext = async () => {
      if (phase === "audio context") {
        entered.resolve();
        await gate.promise;
      }
      const context = new globalThis.AudioContext();
      const createSource = context.createMediaStreamSource.bind(context);
      context.createMediaStreamSource = (...args) => {
        const source = createSource(...args);
        source.connect = () => {
          if (stopped) connectionsAfterStop++;
        };
        return source;
      };
      if (phase === "worklet module") {
        context.audioWorklet.addModule = async () => {
          entered.resolve();
          await gate.promise;
        };
      }
      return context;
    };
    r.manager.beginMicRecovery = async () => {
      if (phase === "mic recovery") {
        entered.resolve();
        await gate.promise;
      }
      recoveryActive = true;
    };
    r.manager.micRecovery.stop = () => {
      recoveryActive = false;
    };
    const started = r.manager.startStreamingRecording();
    await entered.promise;
    stopped = true;
    const ended = r.manager.stopStreamingRecording();
    worklet.releaseQueue();
    await new Promise(setImmediate);
    const stoppedBeforeSetupSettled = trackStops;
    gate.resolve();
    await Promise.all([started, ended]);
    assert.equal(connectionsAfterStop, 0, "late setup cannot open another capture window");
    if (phase !== "activation")
      assert.ok(trackStops > 0, "the late or existing microphone is released");
    if (!["activation", "microphone"].includes(phase))
      assert.ok(stoppedBeforeSetupSettled > 0, "release held track promptly");
    assert.equal(recoveryActive, false, "late recovery initialization must also be stopped");
    assert.equal(r.manager.streamingStream ?? null, null);
    assert.equal(r.manager.isProcessing, false);
    assert.equal(await r.manager.startStreamingRecording(), true, "a settled Stop permits retry");
    await r.manager.cancelStreamingRecording();
  });
}

for (const provider of ["openai-realtime", "tinfoil-realtime", "gemini"]) {
  test(`${provider} Cancel after Stop discards even queued real-worklet flush audio`, async (t) => {
    const s = scenario(t, provider === "gemini" ? "gemini-streaming" : "dictation-realtime");
    const gate = deferConnection();
    const r = await rendererScenario(t, s, provider);
    const worklet = await installRealStreamingWorklet(t, r.manager);
    const started = r.manager.startStreamingRecording();
    while (!r.calls.includes("start")) await new Promise(setImmediate);
    worklet.process(800, 1);
    worklet.deliverQueued();
    worklet.process(800, 2);
    worklet.process(134, 3);
    const stopped = r.manager.stopStreamingRecording();
    const cancelled = r.manager.cancelStreamingRecording();
    worklet.releaseQueue();
    assert.equal(await r.manager.startStreamingRecording(), false);
    gate.resolve();
    await Promise.all([started, stopped, cancelled]);
    const socket = provider === "gemini" ? geminiSockets.at(-1) : instances.at(-1).testSocket;
    assert.equal(Buffer.concat(socket.audio).length, 0);
    assert.equal(socket.commits, 0);
    assert.equal(socket.readyState, WS.CLOSED);
    assert.deepEqual(r.completions, []);
    assert.deepEqual(r.errors, []);
    assert.equal(r.manager.streamingStream ?? null, null);
    assert.equal(r.manager.isProcessing, false);
  });
}

for (const provider of ["openai-realtime", "tinfoil-realtime", "gemini"]) {
  test(`${provider} startup rejection after Stop returns to idle and permits retry`, async (t) => {
    const s = scenario(t, provider === "gemini" ? "gemini-streaming" : "dictation-realtime");
    const r = await rendererScenario(t, s, provider);
    const states = [];
    r.manager.onStateChange = (state) => states.push(state);
    const gate = (tokenGate = Promise.withResolvers());
    const started = r.manager.startStreamingRecording();
    while (!r.calls.includes("start")) await new Promise(setImmediate);
    s.send(Buffer.alloc(3200, 1));
    await r.manager.stopStreamingRecording();
    gate.reject(new Error("test token unavailable"));
    assert.equal(await started, false);
    assert.equal(
      r.manager.getState().isProcessing,
      false,
      "failed startup must release the processing guard"
    );
    assert.equal(r.manager.getState().isRecording, false);
    assert.equal(r.manager.getState().isStreaming, false);
    assert.equal(r.manager.streamingStartInProgress, false);
    assert.deepEqual(r.completions, []);
    assert.equal(r.errors.length, 1, "the failed request surfaces once");
    assert.equal(states.at(-1).isProcessing, false, "reported state matches the internal state");
    assert.equal(r.manager.streamingStream, null);
    tokenGate = null;
    assert.equal(
      await r.manager.startStreamingRecording(),
      true,
      "the next dictation is not blocked"
    );
    await r.manager.cancelStreamingRecording();
  });
}

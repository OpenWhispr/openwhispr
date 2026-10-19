const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const Module = require("node:module");
const WS = require("ws");
const { loadAudioManager } = require("./harness/audioManager");

const SNAPSHOT = "gpt-4o-mini-transcribe-2025-12-15";
const TEXT = "Silent streaming history fixture.";
const handlers = new Map();
const originalLoad = Module._load;
const noop = () => {};
const electron = {
  app: {
    getPath: () => "/tmp",
    getName: () => "test",
    getVersion: () => "0.0.0",
    isPackaged: false,
    on: noop,
    requestSingleInstanceLock: () => true,
  },
  ipcMain: { handle: (channel, handler) => handlers.set(channel, handler), on: noop },
  BrowserWindow: class {
    static getAllWindows() {
      return [];
    }
  },
  net: {},
  shell: {},
  session: {},
  systemPreferences: { getMediaAccessStatus: () => "granted" },
};

// Use the real registered handlers while excluding Electron, logging, devices,
// and persistence. No constructor starts the main process or opens a database.
Module._load = function (request, parent, isMain) {
  if (request === "electron") return electron;
  if (request === "./debugLogger") return new Proxy({}, { get: () => noop });
  return originalLoad.call(this, request, parent, isMain);
};
const IPCHandlers = require("../../src/helpers/ipcHandlers");
const OpenAIRealtimeStreaming = require("../../src/helpers/openaiRealtimeStreaming");
const { TinfoilRealtimeStreaming } = require("../../src/helpers/tinfoilRealtimeStreaming");
const DeepgramStreaming = require("../../src/helpers/deepgramStreaming");
Module._load = originalLoad;

function anything() {
  return new Proxy(noop, {
    get: (_target, key) => (key === "then" ? undefined : anything()),
    apply: () => anything(),
  });
}

function registerHandlers(streaming, providerName) {
  const persisted = [];
  const analytics = [];
  const target = {
    _dictationStreaming: providerName === "deepgram" ? null : streaming,
    deepgramStreaming: providerName === "deepgram" ? streaming : null,
    _dictationPreviewEnabled: false,
    databaseManager: {
      getTranscriptionById: () => ({ id: 1 }),
      updateTranscriptionAudio: (id, metadata) => persisted.push({ id, ...metadata }),
      recordAnalyticsEvent: (event) => {
        analytics.push(event);
        return { success: true };
      },
    },
    audioStorageManager: { saveAudio: () => ({ success: true }) },
  };
  IPCHandlers.prototype.setupHandlers.call(
    new Proxy(target, { get: (value, key) => (key in value ? value[key] : anything()) })
  );
  for (const channel of [
    "dictation-realtime-stop",
    "deepgram-streaming-stop",
    "analytics-record-event",
    "save-transcription-audio",
  ]) {
    assert.ok(handlers.has(channel), `${channel} must be registered`);
  }
  return { persisted, analytics };
}

async function connectFakeSession(t, { providerName, model, serverModel }) {
  const socket = new EventEmitter();
  socket.readyState = WS.CONNECTING;
  socket.ping = noop;
  socket.close = () => {
    socket.readyState = WS.CLOSED;
  };
  const streaming =
    providerName === "tinfoil-realtime"
      ? new TinfoilRealtimeStreaming(async () => socket)
      : new OpenAIRealtimeStreaming();
  t.after(() => streaming.cleanup());
  socket.send = (raw) => {
    if (JSON.parse(raw).type === "input_audio_buffer.commit") {
      socket.emit(
        "message",
        JSON.stringify({
          type: "conversation.item.input_audio_transcription.completed",
          transcript: TEXT,
        })
      );
    }
  };
  const connected = streaming.connect({
    apiKey: "fake-test-credential",
    model,
    preconfigured: !!serverModel,
    createSocket: async () => socket,
  });
  await new Promise((resolve) => setImmediate(resolve));
  socket.readyState = WS.OPEN;
  socket.emit(
    "message",
    JSON.stringify({
      type: "session.created",
      session: serverModel ? { audio: { input: { transcription: { model: serverModel } } } } : {},
    })
  );
  if (!serverModel) socket.emit("message", JSON.stringify({ type: "session.updated" }));
  await connected;
  streaming.sendAudio(Buffer.alloc(4800));
  return streaming;
}

async function finalizeAndSave(t, { streaming, providerName, expectedModel }) {
  const { persisted, analytics } = registerHandlers(streaming, providerName);
  const { AudioManager, window, setSettings } = await loadAudioManager(t, {
    cachePrefix: "streaming-history-model-test-",
    settingsKey: "__streamingHistorySettings",
    settings: { cloudTranscriptionModel: SNAPSHOT },
    mockModules: {
      "/services/SyncService.js": "export const syncService = { debouncedPush() {} };",
    },
  });
  const usage = [];
  const invoke =
    (channel) =>
    (...args) =>
      handlers.get(channel)({}, ...args);
  Object.assign(window.electronAPI, {
    dictationRealtimeStop: invoke("dictation-realtime-stop"),
    deepgramStreamingStop: invoke("deepgram-streaming-stop"),
    deepgramStreamingFinalize: noop,
    recordAnalyticsEvent: invoke("analytics-record-event"),
    saveTranscriptionAudio: invoke("save-transcription-audio"),
    saveTranscription: async () => ({ id: 1 }),
    cloudStreamingUsage: async (_text, _duration, metadata) => {
      usage.push(metadata);
      return { success: true };
    },
  });
  window.dispatchEvent = noop;
  // Settings now describe a different model/provider from the open session.
  setSettings({
    useLocalWhisper: false,
    transcriptionMode: "providers",
    cloudTranscriptionMode: "byok",
    cloudTranscriptionProvider: "deepgram",
    cloudTranscriptionModel: "nova-2",
    dataRetentionEnabled: true,
    audioRetentionDays: 7,
  });
  let completion;
  const manager = Object.assign(Object.create(AudioManager.prototype), {
    isRecording: true,
    isStreaming: true,
    isProcessing: false,
    streamingStartInProgress: false,
    recordingStartTime: Date.now() - 1000,
    _streamingStopPromise: null,
    _streamingStopMode: null,
    _streamingCancellationGeneration: 0,
    _activeStreamingSessionId: 7,
    _activeStreamingProviderName: providerName,
    streamingFinalText: providerName === "deepgram" || !streaming?.sendAudio ? TEXT : "",
    streamingPartialText: "",
    streamingCleanupFns: [],
    _streamingFallbackSegments: [],
    micRecovery: { stop() {} },
    finishStreamingFallbackSegment: async () => null,
    mergeRecordedSegments: async () => new Blob([Buffer.alloc(4800)], { type: "audio/wav" }),
    awaitStreamingTextSettled: async () => {},
    getEffectiveSttLanguage: () => "auto",
    finalizeChineseScript: async (text) => text,
    onTranscriptionComplete: (result) => {
      completion = result;
    },
  });
  assert.equal(await manager.stopStreamingRecording(), true);
  assert.equal(completion.text, TEXT);
  assert.equal(completion.source, `${providerName}-streaming`);
  assert.equal(manager.lastAudioMetadata.model, expectedModel);
  assert.equal(
    await manager.saveTranscription(completion.text, completion.rawText, completion),
    true
  );
  assert.equal(analytics.length, 1);
  assert.equal(analytics[0].model, expectedModel);
  assert.equal(analytics[0].provider, `${providerName}-streaming`);
  assert.equal(persisted.length, 1);
  assert.equal(persisted[0].model, expectedModel);
  assert.equal(persisted[0].provider, `${providerName}-streaming`);
  assert.equal(usage.length, 1);
  assert.equal(usage[0].sttModel, expectedModel);
  assert.equal(usage[0].sttProvider, providerName);
  if (streaming?.sendAudio) assert.equal(usage[0].audioSizeBytes, 4800);
}

for (const scenario of [
  {
    name: "OpenAI snapshot survives changed settings",
    providerName: "openai-realtime",
    model: SNAPSHOT,
    expectedModel: SNAPSHOT,
  },
  {
    name: "managed OpenAI uses the server-minted model",
    providerName: "openai-realtime",
    model: "gpt-4o-mini-transcribe",
    serverModel: SNAPSHOT,
    expectedModel: SNAPSHOT,
  },
  {
    name: "Tinfoil inherits session model metadata",
    providerName: "tinfoil-realtime",
    model: "voxtral-mini-4b-realtime",
    expectedModel: "voxtral-mini-4b-realtime",
  },
]) {
  test(`${scenario.name} through stop IPC, finalization, analytics and saved audio`, async (t) => {
    const streaming = await connectFakeSession(t, scenario);
    await finalizeAndSave(t, { ...scenario, streaming });
  });
}

test("missing stop metadata stays unknown instead of inventing Nova", async (t) => {
  await finalizeAndSave(t, {
    streaming: null,
    providerName: "openai-realtime",
    expectedModel: null,
  });
});

test("a failed stop with retained transcript saves unknown model attribution", async (t) => {
  await finalizeAndSave(t, {
    streaming: {
      disconnect: async () => {
        throw new Error("Fixture stop failure");
      },
    },
    providerName: "openai-realtime",
    expectedModel: null,
  });
});

test("Deepgram retains its own session model through finalization and persistence", async (t) => {
  const streaming = new DeepgramStreaming();
  streaming.currentModel = "nova-2";
  streaming.audioBytesSent = 4800;
  streaming.accumulatedText = TEXT;
  await finalizeAndSave(t, { streaming, providerName: "deepgram", expectedModel: "nova-2" });
});

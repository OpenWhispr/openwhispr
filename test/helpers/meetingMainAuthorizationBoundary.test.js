const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

const handlersModulePath = require.resolve("../../src/helpers/ipcHandlers");
const originalLoad = Module._load;

function createDeferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

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

test("meeting prepare invalidates authorization while system-audio capability is pending", async (t) => {
  const handlers = new Map();
  const capability = createDeferred();
  const capabilityRequested = createDeferred();
  let streamingClientLookups = 0;
  const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");

  const electronStub = {
    app: {
      getPath: () => "/tmp",
      getName: () => "test",
      getVersion: () => "0.0.0",
      isPackaged: false,
      on: () => {},
      requestSingleInstanceLock: () => true,
    },
    ipcMain: {
      handle: (channel, handler) => handlers.set(channel, handler),
      on: () => {},
      removeHandler: () => {},
    },
    net: { fetch: async () => ({ ok: true, json: async () => ({}) }) },
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

  Module._load = function loadWithMocks(request, parent, isMain) {
    if (request === "electron") return electronStub;
    if (parent?.filename === handlersModulePath && request === "./tokenStore") {
      return {
        get: () => null,
        getState: () => ({ token: null, generation: 0 }),
        subscribe: () => () => {},
      };
    }
    if (parent?.filename === handlersModulePath && request === "./meetingStreamingProviders") {
      return {
        ALLOWED_MEETING_PROVIDERS: new Set(["local", "deepgram-realtime"]),
        getMeetingConnectionKey: (options) => JSON.stringify(options),
        getMeetingStreamingClient: () => {
          streamingClientLookups += 1;
          return class {};
        },
        disconnectMeetingStreamingClient: async () => ({ text: "" }),
      };
    }
    if (parent?.filename === handlersModulePath && request === "./windowBroadcast") {
      return { broadcastToWindows: () => {} };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  Object.defineProperty(process, "platform", { configurable: true, value: "linux" });
  t.after(() => {
    Module._load = originalLoad;
    Object.defineProperty(process, "platform", originalPlatform);
    delete require.cache[handlersModulePath];
  });

  delete require.cache[handlersModulePath];
  const IPCHandlers = require(handlersModulePath);
  const target = {
    _meetingMicStreaming: null,
    _meetingSystemStreaming: null,
    activeMeetingSpeakerConfig: null,
    audioTapManager: { isSupported: () => false, stop: async () => {} },
    linuxPortalAudioManager: {
      getCapability: () => {
        capabilityRequested.resolve();
        return capability.promise;
      },
      stop: async () => {},
    },
    windowsLoopbackAudioManager: { stop: async () => {} },
    meetingAecManager: null,
    meetingDetectionEngine: {
      endRecordingSession: () => true,
      setUserRecording: () => {},
    },
  };
  IPCHandlers.prototype.setupHandlers.call(
    new Proxy(target, {
      get: (object, property) => (property in object ? object[property] : anything()),
    })
  );

  const prepare = handlers.get("meeting-transcription-prepare");
  const cancel = handlers.get("meeting-transcription-cancel");
  assert.ok(prepare);
  assert.ok(cancel);

  const renderer = { id: 17 };
  const pendingPrepare = prepare(
    { sender: renderer },
    {
      provider: "deepgram-realtime",
      model: "nova-3",
      mode: "byok",
      transportId: "meeting-warm",
    },
    {
      accountId: null,
      workspaceId: null,
      authGeneration: null,
      configGeneration: null,
      category: "transcription",
      provider: "deepgram-realtime",
      model: "nova-3",
      managed: false,
      policyRevision: null,
      transcriptionMode: "providers",
    }
  );
  await capabilityRequested.promise;
  assert.deepEqual(await cancel({ sender: { id: 17 } }, "meeting-warm"), {
    success: false,
    reason: "stale-session",
  });
  await cancel({ sender: renderer }, "meeting-warm");
  capability.resolve({
    available: true,
    supportsSystemAudio: true,
    supportsNativeCapture: true,
  });

  await assert.rejects(pendingPrepare, { code: "AUTHORIZATION_BOUNDARY_CHANGED" });
  assert.equal(streamingClientLookups, 0, "stale prepare must not create a streaming client");
});

test("meeting revocation suppresses callbacks, stale flush results, and diarization", async (t) => {
  const handlers = new Map();
  const sent = [];
  const disconnectCalls = [];
  const diarizationCalls = [];
  const flushStarted = createDeferred();
  const flushCompletion = createDeferred();
  const abortCompletion = createDeferred();
  const queuedAuthorizationValidated = createDeferred();
  const localDecodeStarted = createDeferred();
  let enterpriseConfigGeneration = 11;
  let enterpriseBroadcast;
  let workspacePolicyRevision = 3;
  let workspacePolicyBroadcast;
  let localDecodeSignal;
  let streamingInstance;
  const recordingSessions = [];

  const win = {
    id: 44,
    isDestroyed: () => false,
    webContents: { send: (...args) => sent.push(args) },
  };
  class MeetingStreamingStub {
    constructor() {
      streamingInstance = this;
      this.isConnected = false;
      this.completedSegments = [];
    }

    async connect() {
      this.isConnected = true;
    }

    sendAudio() {
      return true;
    }
  }

  const electronStub = {
    app: {
      getPath: () => "/tmp",
      getName: () => "test",
      getVersion: () => "0.0.0",
      isPackaged: false,
      on: () => {},
      requestSingleInstanceLock: () => true,
    },
    ipcMain: {
      handle: (channel, handler) => handlers.set(channel, handler),
      on: (channel, handler) => handlers.set(channel, handler),
      removeHandler: () => {},
    },
    net: { fetch: async () => ({ ok: true, json: async () => ({}) }) },
    BrowserWindow: class BrowserWindow {
      static getAllWindows() {
        return [win];
      }

      static fromWebContents() {
        return win;
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
    if (parent?.filename === handlersModulePath && request === "./tokenStore") {
      return {
        get: () => "session",
        getState: () => ({ token: "session", generation: 7 }),
        subscribe: () => () => {},
      };
    }
    if (parent?.filename === handlersModulePath && request === "./enterpriseIdentityManager") {
      return {
        createEnterpriseIdentityManager: (options) => {
          enterpriseBroadcast = options.broadcast;
          return {
            getConfig: async () => {
              if (enterpriseConfigGeneration === 12) {
                queuedAuthorizationValidated.resolve();
              }
              return {
                success: true,
                accountId: "account-a",
                workspaceId: "workspace-a",
                authGeneration: 7,
                config: {
                  workspaceId: "workspace-a",
                  generation: enterpriseConfigGeneration,
                  localModels: { transcription: [], reasoning: [] },
                },
              };
            },
            clear() {},
          };
        },
      };
    }
    if (parent?.filename === handlersModulePath && request === "./workspacePolicyManager") {
      return {
        createWorkspacePolicyManager: (options) => {
          workspacePolicyBroadcast = options.broadcast;
          return {
            getPolicy: async () => ({
              success: true,
              accountId: "account-a",
              authGeneration: 7,
              revision: workspacePolicyRevision,
              managed: false,
              policy: null,
            }),
          };
        },
        isScreenContextBlocked: () => false,
        WORKSPACE_POLICY_REASON: {},
      };
    }
    if (parent?.filename === handlersModulePath && request === "./meetingStreamingProviders") {
      return {
        ALLOWED_MEETING_PROVIDERS: new Set(["local", "deepgram-realtime"]),
        getMeetingConnectionKey: (options) => JSON.stringify(options),
        getMeetingStreamingClient: () => MeetingStreamingStub,
        disconnectMeetingStreamingClient: async (_streaming, _provider, flushPending) => {
          disconnectCalls.push(flushPending);
          if (flushPending) {
            flushStarted.resolve();
            await flushCompletion.promise;
            return { text: "stale remote transcript" };
          }
          await abortCompletion.promise;
          return { text: "" };
        },
      };
    }
    if (parent?.filename === handlersModulePath && request === "./realtimeTokenProviders") {
      return { fetchRealtimeTokenForProvider: async () => "meeting-token" };
    }
    if (parent?.filename === handlersModulePath && request === "./liveSpeakerIdentifier") {
      return {
        isAvailable: () => false,
        stop: async () => null,
        setEnabled() {},
        setMaxSpeakers() {},
      };
    }
    if (parent?.filename === handlersModulePath && request === "./windowBroadcast") {
      return { broadcastToWindows: () => {} };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  t.after(() => {
    Module._load = originalLoad;
    delete require.cache[handlersModulePath];
  });

  delete require.cache[handlersModulePath];
  const IPCHandlers = require(handlersModulePath);
  const target = {
    _meetingMicStreaming: null,
    _meetingSystemStreaming: null,
    activeMeetingSpeakerConfig: null,
    speakerDiarizationEnabled: false,
    audioTapManager: { isSupported: () => false, stop: async () => {} },
    linuxPortalAudioManager: { stop: async () => {} },
    windowsLoopbackAudioManager: { stop: async () => {} },
    meetingAecManager: null,
    meetingDetectionEngine: {
      endRecordingSession: () => true,
      setUserRecording: () => {},
      beginRecordingSession: async ({ sessionId }) => {
        recordingSessions.push(sessionId);
        return true;
      },
      recordMeetingAudioChunk: () => {},
    },
    windowManager: { controlPanelWindow: win },
    _resolveInitialMeetingSpeakerConfig: () => ({ enabled: false, expectedCount: 2 }),
    _startOrSkipDiarization: (...args) => diarizationCalls.push(args),
    whisperManager: {
      transcribeLocalWhisper: async (_audio, options) => {
        localDecodeSignal = options.signal;
        localDecodeStarted.resolve();
        await new Promise((resolve, reject) => {
          options.signal.addEventListener(
            "abort",
            () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
            { once: true }
          );
        });
      },
    },
    _resolveWhisperVadOptions: () => ({}),
  };
  IPCHandlers.prototype.setupHandlers.call(
    new Proxy(target, {
      get: (object, property) => (property in object ? object[property] : anything()),
    })
  );

  const context = {
    accountId: "account-a",
    workspaceId: "workspace-a",
    authGeneration: 7,
    configGeneration: 11,
    category: "transcription",
    provider: "deepgram-realtime",
    model: "nova-3",
    managed: false,
    policyRevision: 3,
    transcriptionMode: "providers",
  };
  const renderer = {};
  const started = await handlers.get("meeting-transcription-start")(
    { sender: renderer },
    {
      provider: "deepgram-realtime",
      model: "nova-3",
      mode: "byok",
      sessionId: "meeting-revocation",
    },
    context
  );
  assert.equal(started.success, true, JSON.stringify(started));

  streamingInstance.onPartialTranscript("authorized partial");
  streamingInstance.completedSegments.push("authorized final");
  streamingInstance.onFinalTranscript("authorized final", Date.now());
  const sendsBeforeRevocation = sent.length;

  assert.deepEqual(
    await handlers.get("meeting-transcription-stop")({ sender: {} }, "meeting-revocation"),
    { success: false, reason: "stale-session" }
  );
  assert.deepEqual(
    await handlers.get("meeting-transcription-stop")({ sender: renderer }, undefined),
    { success: false, reason: "stale-session" }
  );
  const stopping = handlers
    .get("meeting-transcription-stop")({ sender: renderer }, "meeting-revocation");
  let stoppedBeforeFlushCompletion = false;
  void stopping.then(() => {
    stoppedBeforeFlushCompletion = true;
  });
  await flushStarted.promise;
  workspacePolicyRevision = 4;
  workspacePolicyBroadcast({
    success: true,
    accountId: "account-a",
    authGeneration: 7,
    revision: workspacePolicyRevision,
    managed: false,
    policy: null,
  });
  enterpriseConfigGeneration = 12;
  enterpriseBroadcast({
    accountId: "account-a",
    workspaceId: "workspace-a",
    authGeneration: 7,
    config: { workspaceId: "workspace-a", generation: 12 },
  });
  const aborting = handlers
    .get("meeting-transcription-abort")({ sender: renderer }, "meeting-revocation");
  await new Promise((resolve) => setImmediate(resolve));
  try {
    assert.equal(
      stoppedBeforeFlushCompletion,
      true,
      "the overtaken graceful stop must not wait for the stale provider flush"
    );
    assert.deepEqual(
      disconnectCalls,
      [true, true, false, false],
      "authorization abort must start non-flushing teardown before the graceful flush settles"
    );
  } finally {
    flushCompletion.resolve();
  }
  const queuedStart = handlers.get("meeting-transcription-start")(
    { sender: renderer },
    {
      provider: "deepgram-realtime",
      model: "nova-3",
      mode: "byok",
      sessionId: "meeting-stale-queued",
    },
    { ...context, configGeneration: 12, policyRevision: 4 }
  );
  await queuedAuthorizationValidated.promise;
  await new Promise((resolve) => setImmediate(resolve));

  enterpriseConfigGeneration = 13;
  enterpriseBroadcast({
    accountId: "account-a",
    workspaceId: "workspace-a",
    authGeneration: 7,
    config: { workspaceId: "workspace-a", generation: 13 },
  });
  abortCompletion.resolve();
  streamingInstance.onPartialTranscript("stale partial");
  streamingInstance.completedSegments.push("stale final");
  streamingInstance.onFinalTranscript("stale final", Date.now());

  const stopped = await stopping;
  const aborted = await aborting;
  assert.equal(sent.length, sendsBeforeRevocation);
  assert.deepEqual(disconnectCalls, [true, true, false, false]);
  assert.deepEqual(stopped, {
    success: false,
    reason: "authorization-changed",
    code: "AUTHORIZATION_BOUNDARY_CHANGED",
  });
  assert.deepEqual(aborted, { success: true });
  assert.deepEqual(await queuedStart, {
    success: false,
    reason: "authorization-changed",
    code: "AUTHORIZATION_BOUNDARY_CHANGED",
  });
  assert.deepEqual(recordingSessions, ["meeting-revocation"]);
  assert.equal(diarizationCalls.length, 0);

  const localContext = {
    ...context,
    configGeneration: 13,
    policyRevision: 4,
    provider: "whisper",
    model: "base",
    transcriptionMode: "local",
  };
  const localStarted = await handlers.get("meeting-transcription-start")(
    { sender: renderer },
    {
      provider: "local",
      localProvider: "whisper",
      localModel: "base",
      sessionId: "meeting-local-revocation",
    },
    localContext
  );
  assert.equal(localStarted.success, true, JSON.stringify(localStarted));
  const samples = new Int16Array(4800);
  samples.fill(12000);
  handlers.get("meeting-transcription-send")({}, Buffer.from(samples.buffer), "system");

  const stoppingLocal = handlers
    .get("meeting-transcription-stop")({ sender: renderer }, "meeting-local-revocation");
  await localDecodeStarted.promise;
  workspacePolicyRevision = 5;
  workspacePolicyBroadcast({
    success: true,
    accountId: "account-a",
    authGeneration: 7,
    revision: workspacePolicyRevision,
    managed: true,
    policy: {
      transcription: { allowedModes: ["providers"], allowedByokProviders: ["openai"] },
    },
  });

  assert.equal(localDecodeSignal.aborted, true);
  assert.deepEqual(await stoppingLocal, {
    success: false,
    reason: "authorization-changed",
    code: "AUTHORIZATION_BOUNDARY_CHANGED",
  });
  assert.equal(diarizationCalls.length, 0);
});

test("meeting revocation during background diarization discards all stale output", async (t) => {
  const electronStub = {
    app: { getPath: () => "/tmp", getName: () => "test", getVersion: () => "0.0.0" },
    ipcMain: { handle() {}, on() {}, removeHandler() {} },
    net: {},
    BrowserWindow: class BrowserWindow {},
    shell: {},
    dialog: {},
    screen: {},
    systemPreferences: {},
    session: {},
    clipboard: {},
    nativeImage: {},
    globalShortcut: {},
    utilityProcess: {},
    MessageChannelMain: class {},
  };
  Module._load = function loadWithMocks(request, parent, isMain) {
    if (request === "electron") return electronStub;
    return originalLoad.call(this, request, parent, isMain);
  };
  t.after(() => {
    Module._load = originalLoad;
    delete require.cache[handlersModulePath];
  });
  delete require.cache[handlersModulePath];
  const IPCHandlers = require(handlersModulePath);
  const diarizationStarted = createDeferred();
  const diarizationCompletion = createDeferred();
  const sent = [];
  let current = true;
  let reconciliationCalls = 0;
  const target = {
    speakerDiarizationEnabled: true,
    diarizationManager: {
      isAvailable: () => true,
      convertRawPcmToWav: async () => "/tmp/ow-stale-diarization.wav",
      diarize: async () => {
        diarizationStarted.resolve();
        return diarizationCompletion.promise;
      },
      capSpeakerClusters: (segments) => segments,
      mergeWithTranscript: (segments) => segments,
    },
    _resolveSpeakerExpectation: () => ({ numSpeakers: -1, cap: 2 }),
    _reconcileLiveSpeakerState: () => {
      reconciliationCalls += 1;
      return new Set();
    },
  };

  IPCHandlers.prototype._startOrSkipDiarization.call(
    target,
    "diarization-revoked",
    "/tmp/ow-stale-raw.pcm",
    Date.now(),
    [{ text: "stale", source: "system", timestamp: Date.now() }],
    {
      isDestroyed: () => false,
      webContents: { send: (...args) => sent.push(args) },
    },
    null,
    { enabled: true },
    7,
    "system",
    () => current
  );

  await diarizationStarted.promise;
  current = false;
  diarizationCompletion.resolve([{ start: 0, end: 1, speaker: "Speaker 1" }]);
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(reconciliationCalls, 0);
  assert.deepEqual(sent, []);
});

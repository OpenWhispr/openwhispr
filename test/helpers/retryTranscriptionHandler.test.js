const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");
const { EventEmitter } = require("node:events");
const AssemblyAiStreaming = require("../../src/helpers/assemblyAiStreaming");
const CortiStreaming = require("../../src/helpers/cortiStreaming");
const DeepgramStreaming = require("../../src/helpers/deepgramStreaming");

const handlersModulePath = require.resolve("../../src/helpers/ipcHandlers");
const { createUploadCancelRegistry } = require("../../src/helpers/uploadCancelRegistry");
const originalLoad = Module._load;

// Captures every ipcMain.handle registration and every net.fetch request so the
// registered handler closures can be invoked directly against a fake `this`.
const handlers = new Map();
const fetches = [];
const databaseWrites = [];
const broadcasts = [];
const assemblyAudioSends = [];
const deepgramAudioSends = [];
const realtimeAudioSends = [];
const realtimeDisconnects = [];
const rendererEvents = [];
const previewAppends = [];
const operationBindings = [];
let fetchResponse = () => ({
  ok: true,
  status: 200,
  json: async () => ({ text: "transcribed" }),
  text: async () => JSON.stringify({ text: "transcribed" }),
});
let tokenState = { token: null, generation: 0 };
let enterpriseConfigResult = null;
let enterpriseConfigBehavior = null;
let enterpriseBroadcast = null;
let workspacePolicyResult = null;
let workspacePolicyBehavior = null;
let workspacePolicyBroadcast = null;
let realtimeDisconnectBehavior = async () => ({ text: "stale transcript" });
let previewTranscriptionBehavior = async () => ({ success: true, text: "preview text" });
let diarizationBehavior = async () => [{ start: 0, end: 1, speaker: "Speaker 1" }];
let activeWindow = null;
let fakeTarget = null;
let realtimeConnectBehavior = async () => {};

const createDeferred = () => {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
};

const createRejectableDeferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

const createRealtimeStreamingStub = (isConnected = true) => ({
  isConnected,
  beginConnecting() {
    this.isConnected = false;
  },
  async connect() {
    await realtimeConnectBehavior();
    this.isConnected = true;
  },
  sendAudio: (buffer) => realtimeAudioSends.push(buffer),
  disconnect: async (options) => {
    realtimeDisconnects.push(options);
    return realtimeDisconnectBehavior(options);
  },
});

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
    handle: (channel, fn) => handlers.set(channel, fn),
    on: (channel, fn) => handlers.set(channel, fn),
    removeHandler: () => {},
  },
  net: {
    fetch: async (url, init) => {
      fetches.push({ url: String(url), init });
      return fetchResponse(String(url), init);
    },
  },
  BrowserWindow: class BrowserWindow {
    static getAllWindows() {
      return [];
    }
    static fromWebContents() {
      return activeWindow;
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

const cortiCalls = [];
const tinfoilCalls = [];
let cortiBehavior = async () => ({ text: "corti text" });
let tinfoilBehavior = async () => ({ text: "tinfoil text", model: "tinfoil-model" });

// Kept installed for the whole file: the corti client is require()d lazily at
// handler invocation time, not at module load.
Module._load = function loadWithMocks(request, parent, isMain) {
  if (request === "electron") return electronStub;
  if (parent?.filename === handlersModulePath) {
    if (request === "./openaiRealtimeStreaming") {
      return class RealtimeStreamingStub {
        constructor() {
          Object.assign(this, createRealtimeStreamingStub(false));
        }
      };
    }
    if (request === "./realtimeTokenProviders") {
      return { fetchRealtimeTokenForProvider: async () => "realtime-token" };
    }
    if (request === "./ffmpegUtils") {
      return {
        convertToWav: async (_sourcePath, wavPath) => {
          fs.writeFileSync(wavPath, Buffer.alloc(32_000));
        },
      };
    }
    if (request === "./tokenStore") {
      return {
        get: () => tokenState.token,
        getState: () => ({ ...tokenState }),
        subscribe: () => () => {},
      };
    }
    if (request === "./managedTranscriptionOperationRegistry") {
      const actual = originalLoad.call(this, request, parent, isMain);
      return {
        createManagedTranscriptionOperationRegistry: (options) => {
          const registry = actual.createManagedTranscriptionOperationRegistry(options);
          return {
            ...registry,
            begin: (operation) => {
              operationBindings.push(operation.binding);
              return registry.begin(operation);
            },
          };
        },
      };
    }
    if (request === "./enterpriseIdentityManager") {
      return {
        createEnterpriseIdentityManager: (options) => {
          enterpriseBroadcast = options.broadcast;
          return {
            getConfig: async (requestOptions) => {
              if (enterpriseConfigBehavior) return enterpriseConfigBehavior(requestOptions);
              return (
                enterpriseConfigResult || {
                  success: false,
                  status: "error",
                  accountId: requestOptions.accountId,
                  workspaceId: requestOptions.workspaceId,
                  authGeneration: requestOptions.expectedAuthGeneration,
                  code: "ENTERPRISE_REQUIRED",
                  enforcementRequired: false,
                }
              );
            },
            clear() {},
          };
        },
      };
    }
    if (request === "./workspacePolicyManager") {
      return {
        createWorkspacePolicyManager: (options) => {
          workspacePolicyBroadcast = options.broadcast;
          return {
            getPolicy: async (requestOptions) => {
              if (workspacePolicyBehavior) return workspacePolicyBehavior(requestOptions);
              return (
                workspacePolicyResult || {
                  success: true,
                  status: "current",
                  revision: 5,
                  accountId: requestOptions.accountId,
                  authGeneration: requestOptions.expectedAuthGeneration,
                  managed: false,
                  policy: null,
                }
              );
            },
          };
        },
        isScreenContextBlocked: () => false,
      };
    }
    if (request === "./cortiTranscription") {
      return {
        transcribeAudio: async (opts) => {
          cortiCalls.push(opts);
          return cortiBehavior(opts);
        },
      };
    }
    if (request === "./tinfoilTranscription") {
      return {
        transcribeWithTinfoil: async (opts) => {
          tinfoilCalls.push(opts);
          return tinfoilBehavior(opts);
        },
        getTinfoilChatModels: () => [],
      };
    }
    if (request === "./windowBroadcast") {
      return { broadcastToWindows: (...args) => broadcasts.push(args) };
    }
  }
  return originalLoad.call(this, request, parent, isMain);
};

// A permissive `this` for setupHandlers: registration only stores closures, so
// any manager not exercised by the retry handler can be an inert stub.
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

function buildFakeThis() {
  const dbRows = new Map([[7, { id: 7, audio_duration_ms: 1200, route_kind: "translation" }]]);
  const target = {
    sessionId: "test-session",
    _uploadCancelRegistry: createUploadCancelRegistry(),
    _cloudTranscriptionRequests: {
      begin: () => new AbortController(),
      complete() {},
      cancelSender() {},
    },
    audioStorageManager: { getAudioBuffer: (id) => (id === 7 ? Buffer.from([1, 2, 3]) : null) },
    databaseManager: {
      updateNote: (...args) => {
        databaseWrites.push(["note", ...args]);
        return { success: true, note: { id: args[0] } };
      },
      updateTranscriptionText: (...args) => databaseWrites.push(["text", ...args]),
      updateTranscriptionStatus: (...args) => databaseWrites.push(["status", ...args]),
      updateTranscriptionAudio: (...args) => databaseWrites.push(["audio", ...args]),
      getTranscriptionById: (id) => dbRows.get(id),
    },
    environmentManager: {
      getOpenAIKey: () => "sk-openai",
      getGroqKey: () => "gk-groq",
      getMistralKey: () => "mk-mistral",
      getXaiKey: () => "xk-xai",
      getTinfoilKey: () => "tk-tinfoil",
      getCustomTranscriptionKey: () => "ck-custom",
      getCortiClientId: () => "corti-id",
      getCortiClientSecret: () => "corti-secret",
    },
    assemblyAiStreaming: {
      isConnected: false,
      hasWarmConnection: () => false,
      getCachedToken: () => "assembly-token",
      disconnect: async () => ({ text: "" }),
      connect: async () => {},
      cleanupAll() {},
      sendAudio: (buffer) => assemblyAudioSends.push(buffer),
    },
    deepgramStreaming: {
      isConnected: false,
      hasWarmConnection: () => false,
      getCachedToken: () => "deepgram-token",
      setTokenRefreshFn() {},
      connect: async () => {},
      disconnect: async () => ({ text: "" }),
      cleanupAll() {},
      sendAudio: (buffer) => {
        deepgramAudioSends.push(buffer);
        return true;
      },
    },
    cortiStreaming: {
      isConnected: false,
      hasWarmConnection: () => false,
      connect: async () => {},
      disconnect: async () => ({ text: "" }),
      sendAudio: () => true,
    },
    _dictationStreaming: null,
    _mintStoredCortiToken: async () => ({
      token: "corti-token",
      environment: "us",
      tenant: "base",
    }),
    whisperManager: {
      serverManager: { isAvailable: () => true },
      transcribeLocalWhisper: (...args) => previewTranscriptionBehavior(...args),
    },
    diarizationManager: {
      isModelDownloaded: () => true,
      diarize: (...args) => diarizationBehavior(...args),
      capSpeakerClusters: (segments) => segments,
    },
    windowManager: {
      showTranscriptionPreview() {},
      hideTranscriptionPreview() {},
      holdTranscriptionPreview() {},
      appendTranscriptionPreview: (text) => previewAppends.push(text),
    },
  };
  fakeTarget = target;
  return new Proxy(target, {
    get: (t, prop) => (prop in t ? t[prop] : anything()),
  });
}

let retryHandler;
test.before(() => {
  delete require.cache[handlersModulePath];
  const IPCHandlers = require(handlersModulePath);
  const Ctor = IPCHandlers.default || IPCHandlers;
  Ctor.prototype.setupHandlers.call(buildFakeThis());
  retryHandler = handlers.get("retry-transcription");
  assert.ok(retryHandler, "retry-transcription must be registered");
});

test.after(() => {
  Module._load = originalLoad;
});

test.beforeEach(() => {
  fetches.length = 0;
  databaseWrites.length = 0;
  broadcasts.length = 0;
  assemblyAudioSends.length = 0;
  deepgramAudioSends.length = 0;
  realtimeAudioSends.length = 0;
  realtimeDisconnects.length = 0;
  rendererEvents.length = 0;
  previewAppends.length = 0;
  operationBindings.length = 0;
  cortiCalls.length = 0;
  tinfoilCalls.length = 0;
  cortiBehavior = async () => ({ text: "corti text" });
  tinfoilBehavior = async () => ({ text: "tinfoil text", model: "tinfoil-model" });
  tokenState = { token: null, generation: 0 };
  enterpriseConfigResult = null;
  enterpriseConfigBehavior = null;
  workspacePolicyResult = null;
  workspacePolicyBehavior = null;
  realtimeDisconnectBehavior = async () => ({ text: "stale transcript" });
  realtimeConnectBehavior = async () => {};
  previewTranscriptionBehavior = async () => ({ success: true, text: "preview text" });
  diarizationBehavior = async () => [{ start: 0, end: 1, speaker: "Speaker 1" }];
  activeWindow = null;
  if (fakeTarget) fakeTarget._dictationStreaming = null;
});

const invoke = (settings, id = 7, requestId) =>
  retryHandler({ sender: {} }, id, settings, requestId);

const enforceManagedWhisper = () => {
  tokenState = { token: "test-token", generation: 7 };
  enterpriseConfigResult = {
    success: true,
    status: "current",
    accountId: "account-a",
    workspaceId: "workspace-a",
    authGeneration: 7,
    config: {
      workspaceId: "workspace-a",
      generation: 11,
      localModels: {
        transcription: [{ provider: "whisper", modelId: "small" }],
        reasoning: [],
      },
    },
  };
  workspacePolicyBroadcast?.({
    success: true,
    accountId: "account-a",
    authGeneration: 7,
    revision: 5,
    managed: false,
    policy: null,
  });
};

const allowPersonalTranscription = () => {
  tokenState = { token: "test-token", generation: 7 };
  enterpriseConfigResult = {
    success: true,
    status: "current",
    accountId: "account-a",
    workspaceId: "workspace-a",
    authGeneration: 7,
    config: {
      workspaceId: "workspace-a",
      generation: 11,
      localModels: { transcription: [], reasoning: [] },
    },
  };
  enterpriseBroadcast?.({
    accountId: "account-a",
    workspaceId: "workspace-a",
    authGeneration: 7,
    config: enterpriseConfigResult.config,
  });
  workspacePolicyBroadcast?.({
    success: true,
    accountId: "account-a",
    authGeneration: 7,
    revision: 5,
    managed: false,
    policy: null,
  });
};

const transcriptionModeForProvider = (provider) => {
  if (provider === "openwhispr") return "openwhispr";
  if (provider === "whisper" || provider === "nvidia") return "local";
  if (provider === "self-hosted") return "self-hosted";
  return "providers";
};

const personalContext = (provider, model, transcriptionMode = transcriptionModeForProvider(provider)) => ({
  accountId: "account-a",
  workspaceId: "workspace-a",
  authGeneration: 7,
  configGeneration: 11,
  policyRevision: 5,
  category: "transcription",
  transcriptionMode,
  provider,
  model,
  managed: false,
});

const guestContext = (provider, model) => ({
  accountId: null,
  workspaceId: null,
  authGeneration: null,
  configGeneration: null,
  policyRevision: null,
  category: "transcription",
  transcriptionMode: transcriptionModeForProvider(provider),
  provider,
  model,
  managed: false,
});

const reasoningContext = (overrides = {}) => ({
  accountId: "account-a",
  workspaceId: "workspace-a",
  authGeneration: 7,
  configGeneration: 11,
  policyRevision: 5,
  signature: "reasoning-signature-a",
  ...overrides,
});

test("deferred action-note admission rejects account, config, policy, and workspace changes", async (t) => {
  const begin = handlers.get("begin-action-note-commit");
  const sender = Object.assign(new EventEmitter(), { id: 71, isDestroyed: () => false });

  await t.test("account", async () => {
    allowPersonalTranscription();
    const deferred = createDeferred();
    enterpriseConfigBehavior = () => deferred.promise;
    const pending = begin({ sender }, 42, reasoningContext());
    await Promise.resolve();
    tokenState = { token: "new-token", generation: 8 };
    deferred.resolve(enterpriseConfigResult);
    const result = await pending;
    assert.equal(result.code, "AUTHORIZATION_BOUNDARY_CHANGED");
  });

  await t.test("config", async () => {
    allowPersonalTranscription();
    const deferred = createDeferred();
    enterpriseConfigBehavior = () => deferred.promise;
    const pending = begin({ sender }, 42, reasoningContext());
    await Promise.resolve();
    enterpriseBroadcast({
      accountId: "account-a",
      workspaceId: "workspace-a",
      authGeneration: 7,
      config: { ...enterpriseConfigResult.config, generation: 12 },
    });
    deferred.resolve(enterpriseConfigResult);
    const result = await pending;
    assert.equal(result.code, "AUTHORIZATION_BOUNDARY_CHANGED");
  });

  await t.test("policy", async () => {
    allowPersonalTranscription();
    const deferred = createDeferred();
    workspacePolicyBehavior = () => deferred.promise;
    const pending = begin({ sender }, 42, reasoningContext());
    while (!workspacePolicyBehavior) await new Promise((resolve) => setImmediate(resolve));
    await Promise.resolve();
    workspacePolicyBroadcast({
      success: true,
      revision: 6,
      accountId: "account-a",
      authGeneration: 7,
      managed: false,
      policy: null,
    });
    deferred.resolve({
      success: true,
      revision: 5,
      accountId: "account-a",
      authGeneration: 7,
      managed: false,
      policy: null,
    });
    const result = await pending;
    assert.equal(result.code, "AUTHORIZATION_BOUNDARY_CHANGED");
  });

  await t.test("workspace", async () => {
    allowPersonalTranscription();
    workspacePolicyBehavior = null;
    const oldWorkspace = createDeferred();
    enterpriseConfigBehavior = (request) =>
      request.workspaceId === "workspace-a"
        ? oldWorkspace.promise
        : Promise.resolve({
            success: true,
            accountId: "account-a",
            workspaceId: "workspace-b",
            authGeneration: 7,
            config: {
              workspaceId: "workspace-b",
              generation: 12,
              localModels: { transcription: [], reasoning: [] },
            },
          });
    const stale = begin({ sender }, 42, reasoningContext());
    await Promise.resolve();
    const current = await begin(
      { sender },
      42,
      reasoningContext({ workspaceId: "workspace-b", configGeneration: 12 })
    );
    assert.equal(current.success, true);
    oldWorkspace.resolve(enterpriseConfigResult);
    const result = await stale;
    assert.equal(result.code, "AUTHORIZATION_BOUNDARY_CHANGED");
  });

  assert.deepEqual(databaseWrites, []);
});

const installStreamingClient = (
  provider,
  { disconnect, connect = async () => {}, onFinalize = () => {}, sendAudio = () => true }
) => {
  const client = {
    isConnected: false,
    hasWarmConnection: () => false,
    getCachedToken: () => `${provider}-token`,
    cacheToken() {},
    setTokenRefreshFn() {},
    connect,
    disconnect,
    cleanupAll() {},
    sendAudio,
    finalize: onFinalize,
    forceEndpoint: onFinalize,
  };
  if (provider === "assemblyai") fakeTarget.assemblyAiStreaming = client;
  if (provider === "deepgram") fakeTarget.deepgramStreaming = client;
  if (provider === "corti") fakeTarget.cortiStreaming = client;
  return client;
};

test("retry: main rejects a renderer-selected cloud route while managed local is required", async () => {
  enforceManagedWhisper();

  const result = await retryHandler(
    { sender: {} },
    7,
    {
      useLocalWhisper: false,
      cloudTranscriptionMode: "openwhispr",
      transcriptionMode: "providers",
    },
    "managed-cloud-bypass",
    personalContext("openwhispr", null)
  );

  assert.equal(result.success, false);
  assert.equal(result.code, "MANAGED_MODEL_REQUIRED");
  assert.deepEqual(databaseWrites, []);
});

test("retry: one main-resolved route controls both authorization and execution", async () => {
  enforceManagedWhisper();

  const result = await retryHandler(
    { sender: {} },
    7,
    {
      useLocalWhisper: true,
      localTranscriptionProvider: "whisper",
      whisperModel: "small",
      transcriptionMode: "self-hosted",
      remoteTranscriptionUrl: "https://self-hosted.example.com/v1/audio/transcriptions",
      remoteTranscriptionModel: "stale-cloud-model",
    },
    "conflicting-stale-route",
    { ...personalContext("whisper", "small"), managed: true }
  );

  assert.equal(result.success, false);
  assert.equal(result.code, "AUTHORIZATION_BOUNDARY_CHANGED");
  assert.equal(
    fetches.length,
    0,
    "a validated local label must not dispatch the self-hosted route"
  );
  assert.deepEqual(databaseWrites, []);
});

test("an authorization change returned during validation cannot be adopted by session binding", async () => {
  allowPersonalTranscription();
  enterpriseConfigBehavior = async () => {
    enterpriseBroadcast({
      accountId: "account-a",
      workspaceId: "workspace-a",
      authGeneration: 7,
      config: {
        workspaceId: "workspace-a",
        generation: 12,
        localModels: { transcription: [], reasoning: [] },
      },
    });
    return enterpriseConfigResult;
  };

  const result = await handlers.get("dictation-realtime-start")(
    { sender: {} },
    { provider: "openai-realtime", model: "gpt-4o-mini-transcribe" },
    personalContext("openai-realtime", "gpt-4o-mini-transcribe")
  );

  assert.equal(result.success, false);
  assert.equal(result.code, "AUTHORIZATION_BOUNDARY_CHANGED");
});

test("a managed-config broadcast for another identity does not revoke an active session", async () => {
  allowPersonalTranscription();
  const model = "gpt-4o-mini-transcribe";
  const started = await handlers.get("dictation-realtime-start")(
    { sender: {} },
    { provider: "openai-realtime", model },
    personalContext("openai-realtime", model)
  );
  assert.equal(started.success, true, JSON.stringify(started));

  handlers.get("dictation-realtime-send")({}, Buffer.from([1]));
  enterpriseBroadcast({
    accountId: "account-b",
    workspaceId: "workspace-b",
    authGeneration: 7,
    config: {
      workspaceId: "workspace-b",
      generation: 12,
      localModels: { transcription: [], reasoning: [] },
    },
  });
  handlers.get("dictation-realtime-send")({}, Buffer.from([2]));

  assert.equal(realtimeAudioSends.length, 2);
});

test("main rejects a token transition while it captures authoritative auth headers", async () => {
  tokenState = { token: "old-token", generation: 7 };
  enterpriseConfigResult = {
    success: true,
    status: "current",
    accountId: "account-a",
    workspaceId: "workspace-a",
    authGeneration: 8,
    config: {
      workspaceId: "workspace-a",
      generation: 11,
      localModels: {
        transcription: [{ provider: "whisper", modelId: "small" }],
        reasoning: [],
      },
    },
  };
  const pending = handlers.get("transcribe-audio-file")(
    { sender: {} },
    "/tmp/not-read.wav",
    { provider: "whisper", model: "small" },
    { ...personalContext("whisper", "small"), authGeneration: 8, managed: true }
  );
  tokenState = { token: null, generation: 8 };

  const result = await pending;
  assert.equal(result.success, false);
  assert.equal(result.code, "AUTHORIZATION_BOUNDARY_CHANGED");
});

test("main rejects managed-local bypasses before file, upload, and proxy transcription work", async (t) => {
  enforceManagedWhisper();
  const sender = { id: 22, once() {}, removeListener() {} };
  const cases = [
    {
      name: "direct local file",
      channel: "transcribe-audio-file",
      args: ["/tmp/not-read.wav", { provider: "whisper", model: "base" }],
      context: personalContext("whisper", "base"),
    },
    {
      name: "direct whisper",
      channel: "transcribe-local-whisper",
      args: [new ArrayBuffer(4), { model: "base" }],
      context: personalContext("whisper", "base"),
    },
    {
      name: "direct parakeet",
      channel: "transcribe-local-parakeet",
      args: [new ArrayBuffer(4), { model: "parakeet-tdt-0.6b-v3" }],
      context: personalContext("nvidia", "parakeet-tdt-0.6b-v3"),
    },
    {
      name: "OpenWhispr cloud buffer",
      channel: "cloud-transcribe",
      args: [new ArrayBuffer(4), {}],
      context: personalContext("openwhispr", null),
    },
    {
      name: "OpenWhispr cloud file",
      channel: "transcribe-audio-file-cloud",
      args: ["/tmp/not-read.wav", {}],
      context: personalContext("openwhispr", null),
    },
    {
      name: "local file diarization companion",
      channel: "diarize-audio-file",
      args: ["/tmp/not-read.wav", { requestId: "managed-diarize-bypass" }],
      context: personalContext("whisper", "base"),
    },
    {
      name: "BYOK file",
      channel: "transcribe-audio-file-byok",
      args: [
        {
          filePath: "/tmp/not-read.wav",
          provider: "openai",
          model: "gpt-4o-mini-transcribe",
          transcriptionMode: "providers",
        },
      ],
      context: personalContext("openai", "gpt-4o-mini-transcribe"),
    },
    {
      name: "xAI proxy",
      channel: "proxy-xai-transcription",
      args: [{ audioBuffer: new ArrayBuffer(4) }],
      context: personalContext("xai", "grok-stt"),
    },
    {
      name: "Mistral proxy",
      channel: "proxy-mistral-transcription",
      args: [{ audioBuffer: new ArrayBuffer(4), model: "voxtral-mini-latest" }],
      context: personalContext("mistral", "voxtral-mini-latest"),
    },
    {
      name: "Corti proxy",
      channel: "proxy-corti-transcription",
      args: [{ audioBuffer: new ArrayBuffer(4) }],
      context: personalContext("corti", "corti-transcribe"),
    },
    {
      name: "Tinfoil proxy",
      channel: "proxy-tinfoil-transcription",
      args: [{ audioBuffer: new ArrayBuffer(4) }],
      context: personalContext("tinfoil", null),
    },
  ];

  for (const testCase of cases) {
    await t.test(testCase.name, async () => {
      enforceManagedWhisper();
      const result = await handlers.get(testCase.channel)(
        { sender },
        ...testCase.args,
        testCase.context
      );
      assert.equal(result.success, false);
      assert.equal(result.code, "MANAGED_MODEL_REQUIRED");
    });
  }
  assert.equal(fetches.length, 0);
});

test("main revocation aborts direct local decode and suppresses its stale result", async () => {
  allowPersonalTranscription();
  const decode = createDeferred();
  let decodeStarted = false;
  let decodeSignal;
  previewTranscriptionBehavior = async (_audio, options) => {
    decodeStarted = true;
    decodeSignal = options.signal;
    return decode.promise;
  };
  const sender = Object.assign(new EventEmitter(), { id: 31 });

  const pending = handlers.get("transcribe-local-whisper")(
    { sender },
    new ArrayBuffer(4),
    { model: "base" },
    personalContext("whisper", "base")
  );
  while (!decodeStarted) await new Promise((resolve) => setImmediate(resolve));

  enterpriseBroadcast({
    accountId: "account-a",
    workspaceId: "workspace-a",
    authGeneration: 7,
    config: {
      workspaceId: "workspace-a",
      generation: 12,
      localModels: { transcription: [], reasoning: [] },
    },
  });
  decode.resolve({ success: true, text: "stale local text" });

  assert.equal(decodeSignal.aborted, true);
  assert.deepEqual(await pending, {
    success: false,
    error: "Transcription authorization changed. Retry the request.",
    code: "AUTHORIZATION_BOUNDARY_CHANGED",
  });
});

test("a workspace-policy broadcast revokes an in-flight direct local decode", async () => {
  allowPersonalTranscription();
  const decode = createDeferred();
  let decodeStarted = false;
  let decodeSignal;
  previewTranscriptionBehavior = async (_audio, options) => {
    decodeStarted = true;
    decodeSignal = options.signal;
    return decode.promise;
  };
  const sender = Object.assign(new EventEmitter(), { id: 33 });

  const pending = handlers.get("transcribe-local-whisper")(
    { sender },
    new ArrayBuffer(4),
    { model: "base" },
    personalContext("whisper", "base")
  );
  while (!decodeStarted) await new Promise((resolve) => setImmediate(resolve));

  workspacePolicyBroadcast({
    success: true,
    revision: 6,
    accountId: "account-a",
    authGeneration: 7,
    managed: true,
    policy: {
      transcription: { allowedModes: ["providers"], allowedByokProviders: ["openai"] },
    },
  });
  decode.resolve({ success: true, text: "stale local text" });

  assert.equal(decodeSignal.aborted, true);
  assert.deepEqual(await pending, {
    success: false,
    error: "Transcription authorization changed. Retry the request.",
    code: "AUTHORIZATION_BOUNDARY_CHANGED",
  });
});

test("a workspace-policy broadcast aborts an in-flight BYOK upload", async () => {
  allowPersonalTranscription();
  let uploadSignal;
  fetchResponse = (_url, init) =>
    new Promise((_resolve, reject) => {
      uploadSignal = init.signal;
      const rejectAbort = () => {
        const error = new Error("aborted provider request");
        error.name = "AbortError";
        reject(error);
      };
      if (uploadSignal.aborted) rejectAbort();
      else uploadSignal.addEventListener("abort", rejectAbort, { once: true });
    });

  try {
    const pending = invokeUpload(
      {
        apiKey: "sk-openai",
        baseUrl: "",
        model: "gpt-4o-mini-transcribe",
        provider: "openai",
        requestId: "workspace-policy-upload",
        transcriptionMode: "providers",
      },
      personalContext("openai", "gpt-4o-mini-transcribe")
    );
    while (!uploadSignal) await new Promise((resolve) => setImmediate(resolve));

    workspacePolicyBroadcast({
      success: true,
      revision: 6,
      accountId: "account-a",
      authGeneration: 7,
      managed: true,
      policy: {
        transcription: { allowedModes: ["local"], allowedByokProviders: [] },
      },
    });

    assert.equal(uploadSignal.aborted, true);
    assert.deepEqual(await pending, {
      success: false,
      error: "Transcription authorization changed. Retry the request.",
      code: "AUTHORIZATION_BOUNDARY_CHANGED",
    });
  } finally {
    fetchResponse = () => ({
      ok: true,
      status: 200,
      json: async () => ({ text: "transcribed" }),
      text: async () => JSON.stringify({ text: "transcribed" }),
    });
  }
});

test("main revocation aborts proxied transcription and suppresses its stale result", async () => {
  allowPersonalTranscription();
  const proxy = createDeferred();
  let proxyStarted = false;
  let proxySignal;
  tinfoilBehavior = async (options) => {
    proxyStarted = true;
    proxySignal = options.signal;
    return proxy.promise;
  };
  const sender = Object.assign(new EventEmitter(), { id: 32 });

  const pending = handlers.get("proxy-tinfoil-transcription")(
    { sender },
    { audioBuffer: new ArrayBuffer(4) },
    personalContext("tinfoil", null)
  );
  while (!proxyStarted) await new Promise((resolve) => setImmediate(resolve));

  enterpriseBroadcast({
    accountId: "account-a",
    workspaceId: "workspace-a",
    authGeneration: 7,
    config: {
      workspaceId: "workspace-a",
      generation: 12,
      localModels: { transcription: [], reasoning: [] },
    },
  });
  proxy.resolve({ text: "stale proxied text" });

  assert.equal(proxySignal.aborted, true);
  assert.deepEqual(await pending, {
    success: false,
    error: "Transcription authorization changed. Retry the request.",
    code: "AUTHORIZATION_BOUNDARY_CHANGED",
    messageKey: undefined,
  });
});

test("main rejects managed-local bypasses before streaming warmup or start", async (t) => {
  enforceManagedWhisper();
  const sender = { id: 23, once() {}, removeListener() {}, send() {} };
  const cases = [
    ["assemblyai-streaming-warmup", "assemblyai", "universal-streaming-multilingual"],
    ["assemblyai-streaming-start", "assemblyai", "universal-streaming-multilingual"],
    ["deepgram-streaming-warmup", "deepgram", "nova-3"],
    ["deepgram-streaming-start", "deepgram", "nova-3"],
    ["corti-streaming-warmup", "corti", "corti-transcribe"],
    ["corti-streaming-start", "corti", "corti-transcribe"],
    ["dictation-realtime-warmup", "openai-realtime", "gpt-4o-mini-transcribe"],
    ["dictation-realtime-start", "openai-realtime", "gpt-4o-mini-transcribe"],
  ];

  for (const [channel, provider, model] of cases) {
    await t.test(channel, async () => {
      enforceManagedWhisper();
      const result = await handlers.get(channel)(
        { sender },
        { provider, model, mode: "openwhispr" },
        personalContext(provider, model, "openwhispr")
      );
      assert.equal(result.success, false);
      assert.equal(result.code, "MANAGED_MODEL_REQUIRED");
    });
  }
  assert.equal(fetches.length, 0);
});

test("main rejects a managed-local bypass before dictation preview state or model work", async () => {
  enforceManagedWhisper();
  const result = await handlers.get("start-dictation-preview")(
    { sender: {} },
    { provider: "whisper", model: "base", display: false },
    personalContext("whisper", "base")
  );

  assert.equal(result.success, false);
  assert.equal(result.code, "MANAGED_MODEL_REQUIRED");
});

test("main rejects a managed-local bypass before meeting prepare or start", async (t) => {
  const sender = { id: 24, once() {}, removeListener() {}, send() {} };
  for (const channel of ["meeting-transcription-prepare", "meeting-transcription-start"]) {
    await t.test(channel, async () => {
      enforceManagedWhisper();
      const result = await handlers.get(channel)(
        { sender },
        {
          provider: "deepgram-realtime",
          model: "nova-3",
          mode: "byok",
          sessionId: "managed-bypass-meeting",
        },
        personalContext("deepgram-realtime", "nova-3")
      );
      assert.equal(result.success, false);
      assert.equal(result.code, "MANAGED_MODEL_REQUIRED");
    });
  }
});

test("streaming audio and finalization require the exact authorized channel and generations", async () => {
  const model = "gpt-4o-mini-transcribe";
  const owner = Object.assign(new EventEmitter(), { id: 40, send() {} });
  const firstTransportId = "generation-guest";
  const started = await handlers.get("dictation-realtime-start")(
    { sender: owner },
    { provider: "openai-realtime", model, transportId: firstTransportId },
    guestContext("openai-realtime", model)
  );
  assert.equal(started.success, true, JSON.stringify(started));

  handlers.get("dictation-realtime-send")({ sender: owner }, firstTransportId, Buffer.from([1]));
  handlers.get("assemblyai-streaming-send")({ sender: owner }, firstTransportId, Buffer.from([2]));
  assert.equal(realtimeAudioSends.length, 1);
  assert.equal(assemblyAudioSends.length, 0, "another provider cannot reuse the active binding");

  tokenState = { token: null, generation: 1 };
  handlers.get("dictation-realtime-send")({ sender: owner }, firstTransportId, Buffer.from([3]));
  assert.equal(realtimeAudioSends.length, 1, "an auth generation change invalidates audio ingest");

  allowPersonalTranscription();
  const secondTransportId = "generation-personal";
  const restarted = await handlers.get("dictation-realtime-start")(
    { sender: owner },
    { provider: "openai-realtime", model, transportId: secondTransportId },
    personalContext("openai-realtime", model)
  );
  assert.equal(restarted.success, true, JSON.stringify(restarted));

  enterpriseBroadcast({
    accountId: "account-a",
    workspaceId: "workspace-a",
    authGeneration: 7,
    config: {
      workspaceId: "workspace-a",
      generation: 12,
      localModels: { transcription: [], reasoning: [] },
    },
  });
  handlers.get("dictation-realtime-send")({ sender: owner }, secondTransportId, Buffer.from([4]));
  assert.equal(realtimeAudioSends.length, 1, "a managed config change invalidates audio ingest");

  const stopped = await handlers.get("dictation-realtime-stop")(
    { sender: owner },
    secondTransportId
  );
  assert.deepEqual(realtimeDisconnects, [{ commit: false }, { commit: false }]);
  assert.equal(stopped.code, "AUTHORIZATION_BOUNDARY_CHANGED");
  assert.equal(stopped.text, undefined, "a revoked session cannot return its transcript");
});

test("dictation audio ingress accepts only the active transport ID and owner renderer", async () => {
  allowPersonalTranscription();
  const model = "gpt-4o-mini-transcribe";
  const owner = Object.assign(new EventEmitter(), { id: 41, send() {} });
  const other = Object.assign(new EventEmitter(), { id: 42, send() {} });
  const started = await handlers.get("dictation-realtime-start")(
    { sender: owner },
    { provider: "openai-realtime", model, transportId: "dictation-active" },
    personalContext("openai-realtime", model)
  );
  assert.equal(started.success, true, JSON.stringify(started));

  handlers.get("dictation-realtime-send")({ sender: owner }, "dictation-active", Buffer.from([1]));
  handlers.get("dictation-realtime-send")({ sender: owner }, "dictation-stale", Buffer.from([2]));
  handlers.get("dictation-realtime-send")({ sender: other }, "dictation-active", Buffer.from([3]));

  assert.deepEqual(realtimeAudioSends, [Buffer.from([1])]);
});

test("dictation warm connection is not reusable by another renderer", async () => {
  allowPersonalTranscription();
  const model = "gpt-4o-mini-transcribe";
  const warmOwner = Object.assign(new EventEmitter(), { id: 51, send() {} });
  const startOwner = Object.assign(new EventEmitter(), { id: 52, send() {} });

  const warmed = await handlers.get("dictation-realtime-warmup")(
    { sender: warmOwner },
    { provider: "openai-realtime", model, transportId: "warm-owner" },
    personalContext("openai-realtime", model)
  );
  assert.equal(warmed.success, true, JSON.stringify(warmed));

  const started = await handlers.get("dictation-realtime-start")(
    { sender: startOwner },
    { provider: "openai-realtime", model, transportId: "warm-owner" },
    personalContext("openai-realtime", model)
  );

  assert.equal(started.success, true, JSON.stringify(started));
  assert.deepEqual(realtimeDisconnects, [{ commit: false }]);
});

test("dictation warm connection is not reusable across account or workspace identity", async () => {
  allowPersonalTranscription();
  const model = "gpt-4o-mini-transcribe";
  const owner = Object.assign(new EventEmitter(), { id: 53, send() {} });
  const warmed = await handlers.get("dictation-realtime-warmup")(
    { sender: owner },
    { provider: "openai-realtime", model, transportId: "identity-warm" },
    personalContext("openai-realtime", model)
  );
  assert.equal(warmed.success, true, JSON.stringify(warmed));

  enterpriseConfigResult = {
    success: true,
    status: "current",
    accountId: "account-b",
    workspaceId: "workspace-b",
    authGeneration: 7,
    config: {
      workspaceId: "workspace-b",
      generation: 11,
      localModels: { transcription: [], reasoning: [] },
    },
  };
  enterpriseBroadcast({
    accountId: "account-b",
    workspaceId: "workspace-b",
    authGeneration: 7,
    config: enterpriseConfigResult.config,
  });
  const started = await handlers.get("dictation-realtime-start")(
    { sender: owner },
    { provider: "openai-realtime", model, transportId: "identity-warm" },
    {
      ...personalContext("openai-realtime", model),
      accountId: "account-b",
      workspaceId: "workspace-b",
    }
  );

  assert.equal(started.success, true, JSON.stringify(started));
  assert.deepEqual(realtimeDisconnects, [{ commit: false }]);
});

test("managed config revocation closes a warm connection before the same transport restarts", async () => {
  allowPersonalTranscription();
  const model = "gpt-4o-mini-transcribe";
  const owner = Object.assign(new EventEmitter(), { id: 54, send() {} });
  const warmed = await handlers.get("dictation-realtime-warmup")(
    { sender: owner },
    { provider: "openai-realtime", model, transportId: "config-warm" },
    personalContext("openai-realtime", model)
  );
  assert.equal(warmed.success, true, JSON.stringify(warmed));

  enterpriseConfigResult = {
    ...enterpriseConfigResult,
    config: { ...enterpriseConfigResult.config, generation: 12 },
  };
  enterpriseBroadcast({
    accountId: "account-a",
    workspaceId: "workspace-a",
    authGeneration: 7,
    config: enterpriseConfigResult.config,
  });
  const started = await handlers.get("dictation-realtime-start")(
    { sender: owner },
    { provider: "openai-realtime", model, transportId: "config-warm" },
    { ...personalContext("openai-realtime", model), configGeneration: 12 }
  );

  assert.equal(started.success, true, JSON.stringify(started));
  assert.deepEqual(realtimeDisconnects, [{ commit: false }]);
});

test("managed config revocation overtaking streaming stop discards its late transcript", async () => {
  allowPersonalTranscription();
  const model = "gpt-4o-mini-transcribe";
  const owner = Object.assign(new EventEmitter(), { id: 60, send() {} });
  const transportId = "revoked-close";
  const started = await handlers.get("dictation-realtime-start")(
    { sender: owner },
    { provider: "openai-realtime", model, transportId },
    personalContext("openai-realtime", model)
  );
  assert.equal(started.success, true, JSON.stringify(started));

  const disconnect = createDeferred();
  realtimeDisconnectBehavior = () => disconnect.promise;
  const stopping = handlers.get("dictation-realtime-stop")({ sender: owner }, transportId);
  await Promise.resolve();
  enterpriseBroadcast({
    accountId: "account-a",
    workspaceId: "workspace-a",
    authGeneration: 7,
    config: {
      workspaceId: "workspace-a",
      generation: 13,
      localModels: { transcription: [], reasoning: [] },
    },
  });
  disconnect.resolve({ text: "late transcript" });

  const stopped = await stopping;
  assert.equal(stopped.text, "");
});

test("workspace-policy revocation overtaking streaming stop discards its late transcript", async () => {
  allowPersonalTranscription();
  const model = "gpt-4o-mini-transcribe";
  const owner = Object.assign(new EventEmitter(), { id: 61, send() {} });
  const transportId = "workspace-revoked-close";
  const started = await handlers.get("dictation-realtime-start")(
    { sender: owner },
    { provider: "openai-realtime", model, transportId },
    personalContext("openai-realtime", model)
  );
  assert.equal(started.success, true, JSON.stringify(started));

  const disconnect = createDeferred();
  realtimeDisconnectBehavior = () => disconnect.promise;
  const stopping = handlers.get("dictation-realtime-stop")({ sender: owner }, transportId);
  await Promise.resolve();
  workspacePolicyBroadcast({
    success: true,
    revision: 6,
    accountId: "account-a",
    authGeneration: 7,
    managed: true,
    policy: {
      transcription: { allowedModes: ["local"], allowedByokProviders: [] },
    },
  });
  disconnect.resolve({ text: "late transcript" });

  const stopped = await stopping;
  assert.equal(stopped.text, "");
});

test("provider controls require the active transport ID and owning renderer", async (t) => {
  const previousApiUrl = process.env.OPENWHISPR_API_URL;
  process.env.OPENWHISPR_API_URL = "https://api.example.com";
  t.after(() => {
    if (previousApiUrl === undefined) delete process.env.OPENWHISPR_API_URL;
    else process.env.OPENWHISPR_API_URL = previousApiUrl;
  });

  const cases = [
    {
      provider: "openai-realtime",
      model: "gpt-4o-mini-transcribe",
      startChannel: "dictation-realtime-start",
      stopChannel: "dictation-realtime-stop",
    },
    {
      provider: "assemblyai",
      model: "universal-streaming-multilingual",
      startChannel: "assemblyai-streaming-start",
      finalizeChannel: "assemblyai-streaming-force-endpoint",
      stopChannel: "assemblyai-streaming-stop",
    },
    {
      provider: "deepgram",
      model: "nova-3",
      startChannel: "deepgram-streaming-start",
      finalizeChannel: "deepgram-streaming-finalize",
      stopChannel: "deepgram-streaming-stop",
    },
    {
      provider: "corti",
      model: "corti-transcribe",
      startChannel: "corti-streaming-start",
      finalizeChannel: "corti-streaming-finalize",
      stopChannel: "corti-streaming-stop",
    },
  ];

  for (const testCase of cases) {
    await t.test(testCase.provider, async () => {
      allowPersonalTranscription();
      const owner = Object.assign(new EventEmitter(), { id: 61, send() {} });
      const other = Object.assign(new EventEmitter(), { id: 62, send() {} });
      const transportId = `${testCase.provider}-owner`;
      const disconnectCalls = [];
      const finalizeCalls = [];
      activeWindow = {
        id: owner.id,
        isDestroyed: () => false,
        webContents: { send() {} },
      };

      if (testCase.provider === "openai-realtime") {
        realtimeDisconnectBehavior = async (options) => {
          disconnectCalls.push(options);
          return { text: "owned transcript" };
        };
      } else {
        installStreamingClient(testCase.provider, {
          disconnect: async (commit) => {
            disconnectCalls.push(commit);
            return { text: "owned transcript" };
          },
          onFinalize: () => finalizeCalls.push("finalize"),
        });
      }

      const started = await handlers.get(testCase.startChannel)(
        { sender: owner },
        {
          provider: testCase.provider,
          model: testCase.model,
          mode: "byok",
          transportId,
        },
        personalContext(testCase.provider, testCase.model)
      );
      assert.equal(started.success, true, JSON.stringify(started));

      if (testCase.finalizeChannel) {
        handlers.get(testCase.finalizeChannel)({ sender: other }, transportId);
        handlers.get(testCase.finalizeChannel)({ sender: owner }, `${transportId}-old`);
      }
      const otherAbort = await handlers.get("dictation-streaming-abort")(
        { sender: other },
        transportId
      );
      const staleAbort = await handlers.get("dictation-streaming-abort")(
        { sender: owner },
        `${transportId}-old`
      );
      const otherStop = await handlers.get(testCase.stopChannel)({ sender: other }, transportId);
      const staleStop = await handlers.get(testCase.stopChannel)(
        { sender: owner },
        `${transportId}-old`
      );

      assert.equal(otherAbort.code, "AUTHORIZATION_BOUNDARY_CHANGED");
      assert.equal(staleAbort.code, "AUTHORIZATION_BOUNDARY_CHANGED");
      assert.equal(otherStop.code, "AUTHORIZATION_BOUNDARY_CHANGED");
      assert.equal(staleStop.code, "AUTHORIZATION_BOUNDARY_CHANGED");
      assert.deepEqual(disconnectCalls, []);
      assert.deepEqual(finalizeCalls, []);

      if (testCase.finalizeChannel) {
        handlers.get(testCase.finalizeChannel)({ sender: owner }, transportId);
        assert.deepEqual(finalizeCalls, ["finalize"]);
      }
      const stopped = await handlers.get(testCase.stopChannel)({ sender: owner }, transportId);
      assert.equal(stopped.success, true);
      assert.equal(stopped.text, "owned transcript");
      assert.equal(disconnectCalls.length, 1, "the owner closes its provider exactly once");
    });
  }
});

test("authorization revocation interrupts each deferred provider close", async (t) => {
  const previousApiUrl = process.env.OPENWHISPR_API_URL;
  process.env.OPENWHISPR_API_URL = "https://api.example.com";
  t.after(() => {
    if (previousApiUrl === undefined) delete process.env.OPENWHISPR_API_URL;
    else process.env.OPENWHISPR_API_URL = previousApiUrl;
  });

  const cases = [
    {
      provider: "openai-realtime",
      model: "gpt-4o-mini-transcribe",
      startChannel: "dictation-realtime-start",
      stopChannel: "dictation-realtime-stop",
      gracefulArgument: undefined,
      abortArgument: { commit: false },
    },
    {
      provider: "assemblyai",
      model: "universal-streaming-multilingual",
      startChannel: "assemblyai-streaming-start",
      stopChannel: "assemblyai-streaming-stop",
      gracefulArgument: true,
      abortArgument: false,
    },
    {
      provider: "deepgram",
      model: "nova-3",
      startChannel: "deepgram-streaming-start",
      stopChannel: "deepgram-streaming-stop",
      gracefulArgument: true,
      abortArgument: false,
    },
    {
      provider: "corti",
      model: "corti-transcribe",
      startChannel: "corti-streaming-start",
      stopChannel: "corti-streaming-stop",
      gracefulArgument: true,
      abortArgument: false,
    },
  ];

  for (const [index, testCase] of cases.entries()) {
    await t.test(testCase.provider, async () => {
      allowPersonalTranscription();
      const owner = Object.assign(new EventEmitter(), { id: 71 + index, send() {} });
      const transportId = `${testCase.provider}-deferred`;
      const gracefulClose = createDeferred();
      const disconnectCalls = [];
      activeWindow = {
        id: owner.id,
        isDestroyed: () => false,
        webContents: { send() {} },
      };

      const disconnect = (argument) => {
        disconnectCalls.push(argument);
        return argument === false || argument?.commit === false
          ? Promise.resolve({ text: "" })
          : gracefulClose.promise;
      };
      if (testCase.provider === "openai-realtime") {
        realtimeDisconnectBehavior = disconnect;
      } else {
        installStreamingClient(testCase.provider, { disconnect });
      }

      const started = await handlers.get(testCase.startChannel)(
        { sender: owner },
        {
          provider: testCase.provider,
          model: testCase.model,
          mode: "byok",
          transportId,
        },
        personalContext(testCase.provider, testCase.model)
      );
      assert.equal(started.success, true, JSON.stringify(started));

      const stopping = handlers.get(testCase.stopChannel)({ sender: owner }, transportId);
      while (disconnectCalls.length === 0) await new Promise((resolve) => setImmediate(resolve));
      enterpriseBroadcast({
        accountId: "account-a",
        workspaceId: "workspace-a",
        authGeneration: 7,
        config: {
          workspaceId: "workspace-a",
          generation: 12,
          localModels: { transcription: [], reasoning: [] },
        },
      });
      await Promise.resolve();
      assert.equal(
        disconnectCalls.length,
        2,
        "revocation must start a non-committing close before graceful finalization settles"
      );
      gracefulClose.resolve({ text: "late transcript" });

      const stopped = await stopping;
      assert.deepEqual(disconnectCalls, [testCase.gracefulArgument, testCase.abortArgument]);
      assert.equal(stopped.text, "");
    });
  }
});

test("same-provider replacement settles the old client before owning a fresh client", async (t) => {
  const previousApiUrl = process.env.OPENWHISPR_API_URL;
  process.env.OPENWHISPR_API_URL = "https://api.example.com";
  t.after(() => {
    if (previousApiUrl === undefined) delete process.env.OPENWHISPR_API_URL;
    else process.env.OPENWHISPR_API_URL = previousApiUrl;
  });

  const cases = [
    {
      provider: "assemblyai",
      model: "universal-streaming-multilingual",
      channel: "assemblyai-streaming-start",
      Client: AssemblyAiStreaming,
    },
    {
      provider: "deepgram",
      model: "nova-3",
      channel: "deepgram-streaming-start",
      Client: DeepgramStreaming,
    },
    {
      provider: "corti",
      model: "corti-transcribe",
      channel: "corti-streaming-start",
      Client: CortiStreaming,
    },
  ];

  for (const [index, testCase] of cases.entries()) {
    await t.test(testCase.provider, async (subtest) => {
      allowPersonalTranscription();
      const owner = Object.assign(new EventEmitter(), { id: 81 + index, send() {} });
      activeWindow = {
        id: owner.id,
        isDestroyed: () => false,
        webContents: { send() {} },
      };
      const oldClose = createDeferred();
      let oldTeardownStarted = false;
      const oldClient = installStreamingClient(testCase.provider, {
        disconnect: async (commit) => {
          if (commit === false) {
            oldTeardownStarted = true;
            return oldClose.promise;
          }
          return { text: "" };
        },
      });
      const freshConnections = [];
      const originalMethods = new Map();
      const replacementMethods = {
        hasWarmConnection() {
          return false;
        },
        getCachedToken() {
          return `${testCase.provider}-fresh-token`;
        },
        cacheToken() {},
        setTokenRefreshFn() {},
        async connect() {
          freshConnections.push(this);
          this.isConnected = true;
        },
        async disconnect() {
          return { text: "" };
        },
        cleanupAll() {},
      };
      for (const [method, replacement] of Object.entries(replacementMethods)) {
        originalMethods.set(method, testCase.Client.prototype[method]);
        testCase.Client.prototype[method] = replacement;
      }
      subtest.after(() => {
        for (const [method, original] of originalMethods) {
          if (original === undefined) delete testCase.Client.prototype[method];
          else testCase.Client.prototype[method] = original;
        }
      });

      const firstTransportId = `${testCase.provider}-first`;
      const first = await handlers.get(testCase.channel)(
        { sender: owner },
        { provider: testCase.provider, model: testCase.model, transportId: firstTransportId },
        personalContext(testCase.provider, testCase.model)
      );
      assert.equal(first.success, true, JSON.stringify(first));

      let replacementSettled = false;
      const secondTransportId = `${testCase.provider}-second`;
      const replacing = handlers
        .get(testCase.channel)(
          { sender: owner },
          { provider: testCase.provider, model: testCase.model, transportId: secondTransportId },
          personalContext(testCase.provider, testCase.model)
        )
        .then((result) => {
          replacementSettled = true;
          return result;
        });
      while (!oldTeardownStarted) await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
      const settledBeforeTeardown = replacementSettled;
      oldClose.resolve({ text: "" });
      const second = await replacing;

      assert.equal(settledBeforeTeardown, false, "replacement must await the old teardown");
      assert.equal(second.success, true, JSON.stringify(second));
      assert.equal(freshConnections.length, 1);
      assert.notEqual(freshConnections[0], oldClient);
      const singleton =
        testCase.provider === "assemblyai"
          ? fakeTarget.assemblyAiStreaming
          : testCase.provider === "deepgram"
            ? fakeTarget.deepgramStreaming
            : fakeTarget.cortiStreaming;
      assert.equal(singleton, freshConnections[0]);

      const aborted = await handlers.get("dictation-streaming-abort")(
        { sender: owner },
        secondTransportId
      );
      assert.equal(aborted.success, true);
    });
  }
});

test("Corti warm revocation and replacement close the old warm transport", async (t) => {
  const originalWarmup = CortiStreaming.prototype.warmup;
  const originalDisconnect = CortiStreaming.prototype.disconnect;
  CortiStreaming.prototype.warmup = async function warmup() {
    this.warmConnectionReady = true;
  };
  CortiStreaming.prototype.disconnect = async function disconnect() {
    this.cleanupWarmConnection();
    return { text: "" };
  };
  t.after(() => {
    CortiStreaming.prototype.warmup = originalWarmup;
    CortiStreaming.prototype.disconnect = originalDisconnect;
  });

  const owner = Object.assign(new EventEmitter(), { id: 90, send() {} });
  const createWarmClient = () => {
    let warm = false;
    let cleanupCalls = 0;
    return {
      client: {
        isConnected: false,
        hasWarmConnection: () => warm,
        async warmup() {
          warm = true;
        },
        async disconnect() {
          return { text: "" };
        },
        cleanupWarmConnection() {
          cleanupCalls += 1;
          warm = false;
        },
      },
      cleanupCalls: () => cleanupCalls,
    };
  };

  allowPersonalTranscription();
  const revokedWarm = createWarmClient();
  fakeTarget.cortiStreaming = revokedWarm.client;
  const warmed = await handlers.get("corti-streaming-warmup")(
    { sender: owner },
    { provider: "corti", model: "corti-transcribe", transportId: "corti-warm-revoke" },
    personalContext("corti", "corti-transcribe")
  );
  assert.equal(warmed.success, true, JSON.stringify(warmed));
  enterpriseBroadcast({
    accountId: "account-a",
    workspaceId: "workspace-a",
    authGeneration: 7,
    config: {
      workspaceId: "workspace-a",
      generation: 12,
      localModels: { transcription: [], reasoning: [] },
    },
  });
  await Promise.resolve();
  assert.equal(revokedWarm.cleanupCalls(), 1);
  assert.equal(fakeTarget.cortiStreaming, null);

  allowPersonalTranscription();
  const replacedWarm = createWarmClient();
  fakeTarget.cortiStreaming = replacedWarm.client;
  const firstWarm = await handlers.get("corti-streaming-warmup")(
    { sender: owner },
    { provider: "corti", model: "corti-transcribe", transportId: "corti-warm-first" },
    personalContext("corti", "corti-transcribe")
  );
  assert.equal(firstWarm.success, true, JSON.stringify(firstWarm));
  const secondWarm = await handlers.get("corti-streaming-warmup")(
    { sender: owner },
    { provider: "corti", model: "corti-transcribe", transportId: "corti-warm-second" },
    personalContext("corti", "corti-transcribe")
  );
  assert.equal(secondWarm.success, true, JSON.stringify(secondWarm));
  assert.equal(replacedWarm.cleanupCalls(), 1);
  assert.notEqual(fakeTarget.cortiStreaming, replacedWarm.client);
});

test("dictation provider callbacks cannot publish after their exact authorization changes", async (t) => {
  const previousApiUrl = process.env.OPENWHISPR_API_URL;
  process.env.OPENWHISPR_API_URL = "https://api.example.com";
  t.after(() => {
    if (previousApiUrl === undefined) delete process.env.OPENWHISPR_API_URL;
    else process.env.OPENWHISPR_API_URL = previousApiUrl;
  });
  const sender = { id: 31, send: (...args) => rendererEvents.push(args) };
  activeWindow = {
    id: 31,
    isDestroyed: () => false,
    webContents: { send: (...args) => rendererEvents.push(args) },
  };
  const cases = [
    {
      channel: "dictation-realtime-start",
      provider: "openai-realtime",
      model: "gpt-4o-mini-transcribe",
      client: () => fakeTarget._dictationStreaming,
    },
    {
      channel: "assemblyai-streaming-start",
      provider: "assemblyai",
      model: "universal-streaming-multilingual",
      client: () => fakeTarget.assemblyAiStreaming,
    },
    {
      channel: "deepgram-streaming-start",
      provider: "deepgram",
      model: "nova-3",
      client: () => fakeTarget.deepgramStreaming,
    },
    {
      channel: "corti-streaming-start",
      provider: "corti",
      model: "corti-transcribe",
      client: () => fakeTarget.cortiStreaming,
    },
  ];

  for (const testCase of cases) {
    await t.test(testCase.provider, async () => {
      rendererEvents.length = 0;
      activeWindow = {
        id: 31,
        isDestroyed: () => false,
        webContents: { send: (...args) => rendererEvents.push(args) },
      };
      if (testCase.provider !== "openai-realtime") {
        installStreamingClient(testCase.provider, {
          disconnect: async () => ({ text: "" }),
        });
      }
      allowPersonalTranscription();
      const started = await handlers.get(testCase.channel)(
        { sender },
        { provider: testCase.provider, model: testCase.model, mode: "byok" },
        personalContext(testCase.provider, testCase.model)
      );
      assert.equal(started.success, true, JSON.stringify(started));

      const client = testCase.client();
      client.onPartialTranscript("authorized partial");
      client.onFinalTranscript("authorized final");
      assert.equal(rendererEvents.length, 2);

      enterpriseBroadcast({
        accountId: "account-a",
        workspaceId: "workspace-a",
        authGeneration: 7,
        config: {
          workspaceId: "workspace-a",
          generation: 12,
          localModels: { transcription: [], reasoning: [] },
        },
      });
      client.onPartialTranscript("stale partial");
      client.onFinalTranscript("stale final");

      assert.equal(rendererEvents.length, 2);
    });
  }
});

test("dictation provider callbacks require the exact live operation and client", async (t) => {
  const previousApiUrl = process.env.OPENWHISPR_API_URL;
  process.env.OPENWHISPR_API_URL = "https://api.example.com";
  t.after(() => {
    if (previousApiUrl === undefined) delete process.env.OPENWHISPR_API_URL;
    else process.env.OPENWHISPR_API_URL = previousApiUrl;
  });

  const cases = [
    {
      provider: "openai-realtime",
      model: "gpt-4o-mini-transcribe",
      startChannel: "dictation-realtime-start",
      stopChannel: "dictation-realtime-stop",
      client: () => fakeTarget._dictationStreaming,
      gracefulArgument: undefined,
    },
    {
      provider: "assemblyai",
      model: "universal-streaming-multilingual",
      startChannel: "assemblyai-streaming-start",
      stopChannel: "assemblyai-streaming-stop",
      client: () => fakeTarget.assemblyAiStreaming,
      gracefulArgument: true,
    },
    {
      provider: "deepgram",
      model: "nova-3",
      startChannel: "deepgram-streaming-start",
      stopChannel: "deepgram-streaming-stop",
      client: () => fakeTarget.deepgramStreaming,
      gracefulArgument: true,
    },
    {
      provider: "corti",
      model: "corti-transcribe",
      startChannel: "corti-streaming-start",
      stopChannel: "corti-streaming-stop",
      client: () => fakeTarget.cortiStreaming,
      gracefulArgument: true,
    },
  ];

  for (const [index, testCase] of cases.entries()) {
    await t.test(testCase.provider, async () => {
      allowPersonalTranscription();
      rendererEvents.length = 0;
      const owner = Object.assign(new EventEmitter(), {
        id: 101 + index,
        send: (...args) => rendererEvents.push(args),
      });
      activeWindow = {
        id: owner.id,
        isDestroyed: () => false,
        webContents: { send: (...args) => rendererEvents.push(args) },
      };
      const gracefulClose = createDeferred();
      let gracefulCloseStarted = false;
      const disconnect = (argument) => {
        if (argument === testCase.gracefulArgument) {
          gracefulCloseStarted = true;
          return gracefulClose.promise;
        }
        return Promise.resolve({ text: "" });
      };
      if (testCase.provider === "openai-realtime") {
        realtimeDisconnectBehavior = disconnect;
      } else {
        installStreamingClient(testCase.provider, {
          disconnect: async () => ({ text: "" }),
        });
      }

      const first = await handlers.get(testCase.startChannel)(
        { sender: owner },
        {
          provider: testCase.provider,
          model: testCase.model,
          mode: "byok",
          transportId: `${testCase.provider}-callbacks-first`,
        },
        personalContext(testCase.provider, testCase.model)
      );
      assert.equal(first.success, true, JSON.stringify(first));
      const stalePartial = testCase.client().onPartialTranscript;

      if (testCase.provider !== "openai-realtime") {
        installStreamingClient(testCase.provider, { disconnect });
      }
      const replacementTransportId = `${testCase.provider}-callbacks-replacement`;
      const replacement = await handlers.get(testCase.startChannel)(
        { sender: owner },
        {
          provider: testCase.provider,
          model: testCase.model,
          mode: "byok",
          transportId: replacementTransportId,
        },
        personalContext(testCase.provider, testCase.model)
      );
      assert.equal(replacement.success, true, JSON.stringify(replacement));
      const replacementClient = testCase.client();

      rendererEvents.length = 0;
      stalePartial("stale replacement partial");
      assert.deepEqual(rendererEvents, []);
      replacementClient.onPartialTranscript("current partial");
      assert.equal(rendererEvents.length, 1);

      const stopping = handlers.get(testCase.stopChannel)(
        { sender: owner },
        replacementTransportId
      );
      while (!gracefulCloseStarted) await new Promise((resolve) => setImmediate(resolve));
      replacementClient.onPartialTranscript("closing partial");
      assert.equal(rendererEvents.length, 2, "the retained graceful close still owns callbacks");
      gracefulClose.resolve({ text: "" });
      assert.equal((await stopping).success, true);
      replacementClient.onPartialTranscript("closed partial");
      assert.equal(rendererEvents.length, 2);

      if (testCase.provider === "openai-realtime") {
        realtimeDisconnectBehavior = async () => ({ text: "" });
      } else {
        installStreamingClient(testCase.provider, {
          disconnect: async () => ({ text: "" }),
        });
      }
      const abortTransportId = `${testCase.provider}-callbacks-abort`;
      const abortSession = await handlers.get(testCase.startChannel)(
        { sender: owner },
        {
          provider: testCase.provider,
          model: testCase.model,
          mode: "byok",
          transportId: abortTransportId,
        },
        personalContext(testCase.provider, testCase.model)
      );
      assert.equal(abortSession.success, true, JSON.stringify(abortSession));
      const abortedClient = testCase.client();
      const aborted = await handlers.get("dictation-streaming-abort")(
        { sender: owner },
        abortTransportId
      );
      assert.equal(aborted.success, true);
      abortedClient.onPartialTranscript("aborted partial");
      assert.equal(rendererEvents.length, 2);
    });
  }
});

test("a rejected stale provider start cannot clear a successful successor binding", async (t) => {
  const previousApiUrl = process.env.OPENWHISPR_API_URL;
  process.env.OPENWHISPR_API_URL = "https://api.example.com";
  t.after(() => {
    if (previousApiUrl === undefined) delete process.env.OPENWHISPR_API_URL;
    else process.env.OPENWHISPR_API_URL = previousApiUrl;
  });

  const cases = [
    {
      oldProvider: "openai-realtime",
      oldModel: "gpt-4o-mini-transcribe",
      oldStartChannel: "dictation-realtime-start",
      successorProvider: "assemblyai",
      successorModel: "universal-streaming-multilingual",
      successorStartChannel: "assemblyai-streaming-start",
      successorSendChannel: "assemblyai-streaming-send",
    },
    {
      oldProvider: "assemblyai",
      oldModel: "universal-streaming-multilingual",
      oldStartChannel: "assemblyai-streaming-start",
      successorProvider: "deepgram",
      successorModel: "nova-3",
      successorStartChannel: "deepgram-streaming-start",
      successorSendChannel: "deepgram-streaming-send",
    },
    {
      oldProvider: "deepgram",
      oldModel: "nova-3",
      oldStartChannel: "deepgram-streaming-start",
      successorProvider: "corti",
      successorModel: "corti-transcribe",
      successorStartChannel: "corti-streaming-start",
      successorSendChannel: "corti-streaming-send",
    },
    {
      oldProvider: "corti",
      oldModel: "corti-transcribe",
      oldStartChannel: "corti-streaming-start",
      successorProvider: "openai-realtime",
      successorModel: "gpt-4o-mini-transcribe",
      successorStartChannel: "dictation-realtime-start",
      successorSendChannel: "dictation-realtime-send",
    },
  ];

  for (const [index, testCase] of cases.entries()) {
    await t.test(testCase.oldProvider, async () => {
      allowPersonalTranscription();
      const owner = Object.assign(new EventEmitter(), { id: 111 + index, send() {} });
      activeWindow = {
        id: owner.id,
        isDestroyed: () => false,
        webContents: { send() {} },
      };
      const oldStartFailure = createRejectableDeferred();
      let oldStartReachedBoundary = false;
      if (testCase.oldProvider === "openai-realtime") {
        realtimeConnectBehavior = async () => {
          oldStartReachedBoundary = true;
          await oldStartFailure.promise;
        };
      } else {
        installStreamingClient(testCase.oldProvider, {
          disconnect: async () => ({ text: "" }),
          connect: async () => {
            oldStartReachedBoundary = true;
            return oldStartFailure.promise;
          },
        });
      }

      const oldTransportId = `${testCase.oldProvider}-stale-start`;
      const oldStart = handlers.get(testCase.oldStartChannel)(
        { sender: owner },
        {
          provider: testCase.oldProvider,
          model: testCase.oldModel,
          mode: "byok",
          transportId: oldTransportId,
        },
        personalContext(testCase.oldProvider, testCase.oldModel)
      );
      while (!oldStartReachedBoundary) await new Promise((resolve) => setImmediate(resolve));
      const revoked = await handlers.get("dictation-streaming-abort")(
        { sender: owner },
        oldTransportId
      );
      assert.equal(revoked.success, true);

      let successorAudioSends = 0;
      if (testCase.successorProvider === "openai-realtime") {
        realtimeConnectBehavior = async () => {};
      } else {
        installStreamingClient(testCase.successorProvider, {
          disconnect: async () => ({ text: "" }),
          sendAudio: () => {
            successorAudioSends += 1;
            return true;
          },
        });
      }
      const successorTransportId = `${testCase.successorProvider}-successful-successor`;
      const successor = await handlers.get(testCase.successorStartChannel)(
        { sender: owner },
        {
          provider: testCase.successorProvider,
          model: testCase.successorModel,
          mode: "byok",
          transportId: successorTransportId,
        },
        personalContext(testCase.successorProvider, testCase.successorModel)
      );
      assert.equal(successor.success, true, JSON.stringify(successor));

      oldStartFailure.reject(new Error("older start rejected late"));
      const staleResult = await oldStart;
      assert.equal(staleResult.success, false);

      const realtimeSendCount = realtimeAudioSends.length;
      handlers.get(testCase.successorSendChannel)(
        { sender: owner },
        successorTransportId,
        Buffer.from([1, 2, 3])
      );
      if (testCase.successorProvider === "openai-realtime") {
        assert.equal(realtimeAudioSends.length, realtimeSendCount + 1);
      } else {
        assert.equal(successorAudioSends, 1);
      }
      const successorAbort = await handlers.get("dictation-streaming-abort")(
        { sender: owner },
        successorTransportId
      );
      assert.equal(successorAbort.success, true);
    });
  }
});

test("local preview discards a decode result completed after authorization revocation", async () => {
  allowPersonalTranscription();
  let resolvePreview;
  previewTranscriptionBehavior = () =>
    new Promise((resolve) => {
      resolvePreview = resolve;
    });
  const started = await handlers.get("start-dictation-preview")(
    { sender: {} },
    { provider: "whisper", model: "small", display: true },
    personalContext("whisper", "small")
  );
  assert.equal(started.success, true, JSON.stringify(started));

  const samples = new Int16Array(1600);
  samples.fill(12_000);
  handlers.get("dictation-preview-audio")({}, Buffer.from(samples.buffer));
  const stopping = handlers.get("stop-dictation-preview")({}, { flushed: true });
  while (!resolvePreview) await new Promise((resolve) => setImmediate(resolve));
  enterpriseBroadcast({
    accountId: "account-a",
    workspaceId: "workspace-a",
    authGeneration: 7,
    config: {
      workspaceId: "workspace-a",
      generation: 12,
      localModels: { transcription: [], reasoning: [] },
    },
  });
  resolvePreview({ success: true, text: "stale preview" });
  await stopping;

  assert.deepEqual(previewAppends, []);
});

test("file diarization discards a result completed after authorization revocation", async (t) => {
  allowPersonalTranscription();
  const sourcePath = path.join(os.tmpdir(), `ow-diarize-auth-${process.pid}.wav`);
  fs.writeFileSync(sourcePath, Buffer.alloc(16));
  t.after(() => {
    try {
      fs.unlinkSync(sourcePath);
    } catch {}
  });
  let resolveDiarization;
  diarizationBehavior = () =>
    new Promise((resolve) => {
      resolveDiarization = resolve;
    });

  const pending = handlers.get("diarize-audio-file")(
    { sender: {} },
    sourcePath,
    { requestId: "diarize-revoked" },
    personalContext("whisper", "base")
  );
  while (!resolveDiarization) await new Promise((resolve) => setImmediate(resolve));
  enterpriseBroadcast({
    accountId: "account-a",
    workspaceId: "workspace-a",
    authGeneration: 7,
    config: {
      workspaceId: "workspace-a",
      generation: 12,
      localModels: { transcription: [], reasoning: [] },
    },
  });
  resolveDiarization([{ start: 0, end: 1, speaker: "Speaker 1" }]);

  const result = await pending;
  assert.equal(result.success, false);
  assert.equal(result.code, "AUTHORIZATION_BOUNDARY_CHANGED");
  assert.equal(result.segments, undefined);
});

test("retry: cancelling request ownership prevents late database commit and broadcast", async () => {
  databaseWrites.length = 0;
  broadcasts.length = 0;
  let resolveCorti;
  cortiBehavior = () =>
    new Promise((resolve) => {
      resolveCorti = resolve;
    });
  try {
    const callCount = cortiCalls.length;
    const retry = invoke(
      {
        cloudTranscriptionProvider: "corti",
        cloudTranscriptionMode: "byok",
        transcriptionMode: "providers",
        cortiEnvironment: "us",
        cortiTenant: "base",
        preferredLanguage: "auto",
      },
      7,
      "history-retry-1"
    );
    while (cortiCalls.length === callCount) {
      await new Promise((resolve) => setImmediate(resolve));
    }

    const cancelled = await handlers.get("cancel-upload-transcription")(
      { sender: {} },
      "history-retry-1"
    );
    resolveCorti({ text: "late corti result" });
    const result = await retry;
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(cancelled.success, true);
    assert.equal(result.success, false);
    assert.equal(result.code, "UPLOAD_CANCELLED");
    assert.deepEqual(databaseWrites, []);
    assert.deepEqual(broadcasts, []);
  } finally {
    cortiBehavior = async () => ({ text: "corti text" });
  }
});

test("retry: an authorization change during transcription discards the returned result", async () => {
  allowPersonalTranscription();
  let resolveCorti;
  cortiBehavior = () =>
    new Promise((resolve) => {
      resolveCorti = resolve;
    });
  try {
    const retry = retryHandler(
      { sender: {} },
      7,
      {
        cloudTranscriptionProvider: "corti",
        cloudTranscriptionMode: "byok",
        transcriptionMode: "providers",
        cortiEnvironment: "us",
        cortiTenant: "base",
      },
      "history-retry-revoked-in-flight",
      personalContext("corti", "corti-transcribe")
    );
    while (!resolveCorti) await new Promise((resolve) => setImmediate(resolve));
    enterpriseBroadcast({
      accountId: "account-a",
      workspaceId: "workspace-a",
      authGeneration: 7,
      config: {
        workspaceId: "workspace-a",
        generation: 12,
        localModels: { transcription: [], reasoning: [] },
      },
    });
    resolveCorti({ text: "stale transcription" });

    const result = await retry;
    assert.equal(result.success, false);
    assert.equal(result.code, "AUTHORIZATION_BOUNDARY_CHANGED");
    assert.deepEqual(databaseWrites, []);
    assert.equal(
      broadcasts.some(([channel]) => channel === "transcription-updated"),
      false
    );
  } finally {
    cortiBehavior = async () => ({ text: "corti text" });
  }
});

test("retry: an authorization change invalidates a pending commit before database writes", async () => {
  allowPersonalTranscription();
  const event = { sender: {} };
  const result = await retryHandler(
    event,
    7,
    {
      cloudTranscriptionProvider: "corti",
      cloudTranscriptionMode: "byok",
      transcriptionMode: "providers",
      cortiEnvironment: "us",
      cortiTenant: "base",
    },
    "history-retry-revoked-before-commit",
    personalContext("corti", "corti-transcribe")
  );
  assert.equal(result.pendingCommit, true);

  enterpriseBroadcast({
    accountId: "account-a",
    workspaceId: "workspace-a",
    authGeneration: 7,
    config: {
      workspaceId: "workspace-a",
      generation: 12,
      localModels: { transcription: [], reasoning: [] },
    },
  });
  const committed = await handlers.get("commit-retry-transcription")(
    event,
    7,
    "history-retry-revoked-before-commit",
    "stale final text",
    "stale transcription"
  );

  assert.equal(committed.success, false);
  assert.equal(committed.code, "AUTHORIZATION_BOUNDARY_CHANGED");
  assert.deepEqual(databaseWrites, []);
  assert.equal(
    broadcasts.some(([channel]) => channel === "transcription-updated"),
    false
  );
});

test("retry: request-owned results stay uncommitted until the renderer authorizes commit", async () => {
  databaseWrites.length = 0;
  broadcasts.length = 0;
  const result = await invoke(
    {
      cloudTranscriptionProvider: "corti",
      cloudTranscriptionMode: "byok",
      transcriptionMode: "providers",
      cortiEnvironment: "us",
      cortiTenant: "base",
      preferredLanguage: "auto",
    },
    7,
    "history-retry-2"
  );

  assert.equal(result.success, true);
  assert.equal(result.pendingCommit, true);
  assert.equal(result.transcription.text, "corti text");
  assert.equal(result.transcription.route_kind, "translation");
  assert.deepEqual(databaseWrites, []);
  assert.deepEqual(broadcasts, []);

  const committed = await handlers.get("commit-retry-transcription")(
    { sender: {} },
    7,
    "history-retry-2",
    "clean final text",
    "corti text"
  );
  assert.equal(committed.success, true);
  assert.deepEqual(databaseWrites[0], ["text", 7, "clean final text", "corti text"]);
  assert.equal(databaseWrites.length, 3);
  assert.equal(broadcasts.length, 1);
});

test("retry: cancelling a pending result prevents its later commit", async () => {
  const result = await invoke(
    {
      cloudTranscriptionProvider: "corti",
      cloudTranscriptionMode: "byok",
      transcriptionMode: "providers",
      cortiEnvironment: "us",
      cortiTenant: "base",
      preferredLanguage: "auto",
    },
    7,
    "history-retry-3"
  );
  assert.equal(result.pendingCommit, true);

  const cancelled = await handlers.get("cancel-upload-transcription")(
    { sender: {} },
    "history-retry-3"
  );
  const committed = await handlers.get("commit-retry-transcription")(
    { sender: {} },
    7,
    "history-retry-3",
    "late final text",
    "corti text"
  );

  assert.equal(cancelled.success, true);
  assert.equal(committed.success, false);
  assert.deepEqual(databaseWrites, []);
  assert.deepEqual(broadcasts, []);
});

test("retry: only the renderer that owns a pending result can cancel or commit it", async () => {
  const ownerEvent = { sender: { id: 11 } };
  const otherEvent = { sender: { id: 12 } };
  const result = await retryHandler(
    ownerEvent,
    7,
    {
      cloudTranscriptionProvider: "corti",
      cloudTranscriptionMode: "byok",
      transcriptionMode: "providers",
      cortiEnvironment: "us",
      cortiTenant: "base",
      preferredLanguage: "auto",
    },
    "history-retry-owner"
  );
  assert.equal(result.pendingCommit, true);

  const otherCancel = await handlers.get("cancel-upload-transcription")(
    otherEvent,
    "history-retry-owner"
  );
  const otherCommit = await handlers.get("commit-retry-transcription")(
    otherEvent,
    7,
    "history-retry-owner",
    "wrong owner",
    "corti text"
  );
  const ownerCancel = await handlers.get("cancel-upload-transcription")(
    ownerEvent,
    "history-retry-owner"
  );

  assert.equal(otherCancel.success, false);
  assert.equal(otherCommit.success, false);
  assert.equal(ownerCancel.success, true);
  assert.deepEqual(databaseWrites, []);
  assert.deepEqual(broadcasts, []);
});

test("retry: corti routes to the corti client, never OpenAI", async () => {
  fetches.length = 0;
  const result = await invoke({
    cloudTranscriptionProvider: "corti",
    cloudTranscriptionMode: "byok",
    transcriptionMode: "providers",
    cortiEnvironment: "eu",
    cortiTenant: "acme",
    preferredLanguage: "auto",
  });
  assert.equal(result.success, true);
  assert.equal(cortiCalls.length, 1);
  assert.equal(cortiCalls[0].environment, "eu");
  assert.equal(cortiCalls[0].tenant, "acme");
  assert.equal(cortiCalls[0].language, "en");
  assert.equal(fetches.length, 0, "corti retry must not touch HTTP endpoints");
});

test("retry: custom misconfiguration fails closed with a coded error", async () => {
  fetches.length = 0;
  for (const cloudTranscriptionBaseUrl of ["", "https://api.openai.com/v1", "not a url"]) {
    const result = await invoke({
      cloudTranscriptionProvider: "custom",
      cloudTranscriptionMode: "byok",
      transcriptionMode: "providers",
      cloudTranscriptionBaseUrl,
    });
    assert.equal(result.success, false, cloudTranscriptionBaseUrl);
    assert.equal(result.code, "CUSTOM_ENDPOINT_INVALID", cloudTranscriptionBaseUrl);
  }
  assert.equal(fetches.length, 0);
});

test("retry: openwhispr cloud masks a leftover BYOK misconfiguration", async () => {
  fetches.length = 0;
  const result = await invoke({
    cloudTranscriptionProvider: "custom",
    cloudTranscriptionMode: "openwhispr",
    transcriptionMode: "providers",
    cloudTranscriptionBaseUrl: "",
  });
  // BrowserWindow.fromWebContents is stubbed to null, so the cloud branch
  // produces no result — but the route error must NOT surface.
  assert.equal(result.success, false);
  assert.notEqual(result.code, "CUSTOM_ENDPOINT_INVALID");
  assert.match(result.error, /No transcription engine available/);
  assert.equal(fetches.length, 0);
});

test("retry: Azure custom endpoints get deployment URLs and api-key auth", async () => {
  fetches.length = 0;
  const result = await invoke({
    cloudTranscriptionProvider: "custom",
    cloudTranscriptionMode: "byok",
    transcriptionMode: "providers",
    cloudTranscriptionBaseUrl: "https://myres.openai.azure.com",
    cloudTranscriptionModel: "my-deployment",
  });
  assert.equal(result.success, true);
  assert.equal(fetches.length, 1);
  assert.match(fetches[0].url, /myres\.openai\.azure\.com\/openai\/deployments\/my-deployment/);
  assert.equal(fetches[0].init.headers["api-key"], "ck-custom");
  assert.equal(fetches[0].init.headers.Authorization, undefined);
});

test("retry: plain custom endpoints use Bearer auth at the configured URL", async () => {
  fetches.length = 0;
  const result = await invoke({
    cloudTranscriptionProvider: "custom",
    cloudTranscriptionMode: "byok",
    transcriptionMode: "providers",
    cloudTranscriptionBaseUrl: "https://stt.parasail.example.com/v1",
    cloudTranscriptionModel: "parasail-model",
  });
  assert.equal(result.success, true);
  assert.equal(fetches[0].url, "https://stt.parasail.example.com/v1/audio/transcriptions");
  assert.equal(fetches[0].init.headers.Authorization, "Bearer ck-custom");
});

test("retry: a custom URL on Tinfoil's host is refused in the main process", async () => {
  fetches.length = 0;
  const result = await invoke({
    cloudTranscriptionProvider: "custom",
    cloudTranscriptionMode: "byok",
    transcriptionMode: "providers",
    cloudTranscriptionBaseUrl: "https://inference.tinfoil.sh/v1",
  });
  assert.equal(result.success, false);
  assert.match(result.error, /attested main-process proxy/);
  assert.equal(fetches.length, 0);
  assert.equal(tinfoilCalls.length, 0);
});

test("retry: mistral goes to Mistral with x-api-key", async () => {
  fetches.length = 0;
  const result = await invoke({
    cloudTranscriptionProvider: "mistral",
    cloudTranscriptionMode: "byok",
    transcriptionMode: "providers",
  });
  assert.equal(result.success, true);
  assert.match(fetches[0].url, /api\.mistral\.ai/);
  assert.equal(fetches[0].init.headers["x-api-key"], "mk-mistral");
});

test("proxy transcription handlers resolve to structured errors instead of rejecting", async () => {
  fetchResponse = () => ({
    ok: false,
    status: 401,
    text: async () => "unauthorized",
    json: async () => ({}),
  });
  cortiBehavior = async () => {
    const err = new Error("Corti API Error: 401");
    err.code = "INVALID_KEY";
    throw err;
  };
  try {
    for (const channel of [
      "proxy-mistral-transcription",
      "proxy-xai-transcription",
      "proxy-corti-transcription",
    ]) {
      const fn = handlers.get(channel);
      assert.ok(fn, `${channel} must be registered`);
      const result = await fn({ sender: {} }, { audioBuffer: new ArrayBuffer(4) });
      assert.equal(typeof result.error, "string", channel);
    }
  } finally {
    cortiBehavior = async () => ({ text: "corti text" });
    fetchResponse = () => ({
      ok: true,
      status: 200,
      json: async () => ({ text: "transcribed" }),
      text: async () => JSON.stringify({ text: "transcribed" }),
    });
  }
});

const fsNode = require("node:fs");
const osNode = require("node:os");
const pathNode = require("node:path");

const uploadTempFile = pathNode.join(osNode.tmpdir(), "openwhispr-upload-handler-test.webm");

const invokeUpload = (payload, authorizationContext) => {
  const uploadHandler = handlers.get("transcribe-audio-file-byok");
  assert.ok(uploadHandler, "transcribe-audio-file-byok must be registered");
  fsNode.writeFileSync(uploadTempFile, Buffer.from([1, 2, 3, 4]));
  return uploadHandler(
    { sender: {} },
    { filePath: uploadTempFile, ...payload },
    authorizationContext
  );
};

async function assertInFlightUploadCancellation({ requestId, payload, calls, setBehavior }) {
  let receivedSignal;
  setBehavior((options) => {
    receivedSignal = options.signal;
    if (!receivedSignal)
      return Promise.reject(new Error("Provider did not receive an abort signal"));
    return new Promise((_resolve, reject) => {
      const rejectAbort = () => {
        const error = new Error("Provider request aborted");
        error.name = "AbortError";
        reject(error);
      };
      if (receivedSignal.aborted) rejectAbort();
      else receivedSignal.addEventListener("abort", rejectAbort, { once: true });
    });
  });

  const operation = invokeUpload({ ...payload, requestId });
  while (calls.length === 0) {
    await new Promise((resolve) => setImmediate(resolve));
  }

  const cancelled = await handlers.get("cancel-upload-transcription")({ sender: {} }, requestId);
  assert.equal(cancelled.success, true);
  assert.equal(receivedSignal.aborted, true);

  const result = await operation;
  assert.deepEqual(
    { success: result.success, code: result.code },
    { success: false, code: "UPLOAD_CANCELLED" }
  );
}

test("upload: mistral sends x-api-key with a provider-validated model and no language on auto", async () => {
  fetches.length = 0;
  const result = await invokeUpload({
    apiKey: "mk-mistral",
    baseUrl: "https://api.mistral.ai/v1",
    model: "gpt-4o-mini-transcribe", // stale from an openai era — must degrade
    provider: "mistral",
    language: "",
    transcriptionMode: "providers",
  });
  assert.equal(result.success, true);
  assert.match(fetches[0].url, /api\.mistral\.ai/);
  assert.equal(fetches[0].init.headers["x-api-key"], "mk-mistral");
  assert.equal(fetches[0].init.headers.Authorization, undefined);
  const body = fetches[0].init.body.toString();
  assert.match(body, /voxtral-mini-latest/);
  assert.doesNotMatch(body, /name="language"/);
});

test("upload: openai diarization fields ride the route, Bearer auth", async () => {
  fetches.length = 0;
  const result = await invokeUpload({
    apiKey: "sk-openai",
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-4o-mini-transcribe",
    provider: "openai",
    diarize: true,
    language: "",
    transcriptionMode: "providers",
  }, guestContext("openai", "gpt-4o-transcribe-diarize"));
  assert.equal(result.success, true);
  assert.equal(fetches[0].init.headers.Authorization, "Bearer sk-openai");
  const body = fetches[0].init.body.toString();
  assert.match(body, /gpt-4o-transcribe-diarize/);
  assert.match(body, /diarized_json/);
});

test("upload: authorization and multipart dispatch bind the identical diarization model", async (t) => {
  const routes = [
    {
      name: "OpenAI",
      payload: {
        apiKey: "sk-openai",
        baseUrl: "https://api.openai.com/v1",
        model: "gpt-4o-mini-transcribe",
        provider: "openai",
        diarize: true,
        transcriptionMode: "providers",
      },
      context: guestContext("openai", "gpt-4o-transcribe-diarize"),
      dispatchedModel: "gpt-4o-transcribe-diarize",
      dispatchedProvider: "openai",
    },
    {
      name: "custom on OpenAI",
      payload: {
        apiKey: "ck-custom",
        baseUrl: "https://api.openai.com/v1/audio/transcriptions",
        model: "whisper-1",
        provider: "custom",
        diarize: true,
        transcriptionMode: "providers",
      },
      context: guestContext("custom", "gpt-4o-transcribe-diarize"),
      dispatchedModel: "gpt-4o-transcribe-diarize",
      dispatchedProvider: "custom",
    },
    {
      name: "Mistral",
      payload: {
        apiKey: "mk-mistral",
        baseUrl: "https://api.mistral.ai/v1",
        model: "voxtral-mini-latest",
        provider: "mistral",
        diarize: true,
        transcriptionMode: "providers",
      },
      context: guestContext("mistral", "voxtral-mini-latest"),
      dispatchedModel: "voxtral-mini-latest",
      dispatchedProvider: "mistral",
    },
  ];

  for (const route of routes) {
    await t.test(route.name, async () => {
      fetches.length = 0;
      const result = await invokeUpload(route.payload, route.context);
      assert.equal(result.success, true, JSON.stringify(result));
      const body = fetches[0].init.body.toString();
      assert.match(body, new RegExp(`name="model"[\\s\\S]*?${route.dispatchedModel}`));
      assert.equal(operationBindings.at(-1).provider, route.dispatchedProvider);
      assert.equal(operationBindings.at(-1).model, route.dispatchedModel);
    });
  }
});

test("upload: sentinel custom URL fails closed before any request", async () => {
  fetches.length = 0;
  const result = await invokeUpload({
    apiKey: "ck-custom",
    baseUrl: "https://api.openai.com/v1",
    model: "whisper-1",
    provider: "custom",
    language: "",
    transcriptionMode: "providers",
  });
  assert.equal(result.success, false);
  assert.equal(result.code, "CUSTOM_ENDPOINT_INVALID");
  assert.equal(fetches.length, 0);
});

test("upload: a custom URL on Tinfoil's host is refused in the main process", async () => {
  fetches.length = 0;
  const result = await invokeUpload({
    apiKey: "ck-custom",
    baseUrl: "https://inference.tinfoil.sh/v1",
    model: "whisper-1",
    provider: "custom",
    language: "",
    transcriptionMode: "providers",
  });
  assert.equal(result.success, false);
  assert.match(result.error, /attested main-process proxy/);
  assert.equal(fetches.length, 0);
});

// An uploaded file is frequently not in the dictation language, and a wrong hint
// silently mistranscribes it — so BYOK cloud uploads auto-detect even when the
// user has pinned a preferred language for dictation.
test("upload: a preferred language never constrains a BYOK cloud upload", async () => {
  for (const provider of ["openai", "groq", "custom"]) {
    fetches.length = 0;
    const result = await invokeUpload({
      apiKey: "sk-key",
      baseUrl: provider === "custom" ? "https://gateway.example.com/v1" : "",
      model: "whisper-1",
      provider,
      language: "de",
      transcriptionMode: "providers",
    });
    assert.equal(result.success, true, provider);
    assert.doesNotMatch(fetches[0].init.body.toString(), /name="language"/, provider);
  }
});

test("upload: dictation opts into its resolved language and dictionary prompt", async () => {
  fetches.length = 0;
  const result = await invokeUpload({
    requestId: "dictation-complete",
    apiKey: "sk-openai",
    baseUrl: "https://api.openai.com/v1",
    model: "whisper-1",
    provider: "openai",
    language: "de",
    useLanguageHint: true,
    prompt: "Qdrant, OpenWhispr",
    transcriptionMode: "providers",
  });

  assert.equal(result.success, true);
  const body = fetches[0].init.body.toString();
  assert.match(body, /name="language"[\s\S]*?de/);
  assert.match(body, /name="prompt"[\s\S]*?Qdrant, OpenWhispr/);
  assert.deepEqual(
    await handlers.get("cancel-upload-transcription")({ sender: {} }, "dictation-complete"),
    { success: false },
    "successful requests must release their cancellation registration"
  );
});

test("upload: self-hosted provider errors preserve structured renderer error codes", async () => {
  fetchResponse = () => ({
    ok: false,
    status: 429,
    text: async () => JSON.stringify({ error: "slow down" }),
    json: async () => ({ error: "slow down" }),
  });
  try {
    const result = await invokeUpload({
      apiKey: "",
      baseUrl: "",
      model: "private-whisper",
      provider: "openai",
      language: "",
      transcriptionMode: "self-hosted",
      remoteTranscriptionUrl: "https://stt.internal.example.test",
      remoteTranscriptionModel: "private-whisper",
    });

    assert.equal(result.success, false);
    assert.equal(result.code, "PROVIDER_RATE_LIMITED");
    assert.equal(result.messageKey, "hooks.audioRecording.errorDescriptions.providerRateLimited");
  } finally {
    fetchResponse = () => ({
      ok: true,
      status: 200,
      json: async () => ({ text: "transcribed" }),
      text: async () => JSON.stringify({ text: "transcribed" }),
    });
  }
});

test("upload: cancellation aborts every migrated dictation HTTP provider", async () => {
  const routes = [
    {
      provider: "openai",
      apiKey: "sk-openai",
      baseUrl: "",
      model: "whisper-1",
      transcriptionMode: "providers",
    },
    {
      provider: "groq",
      apiKey: "gk-groq",
      baseUrl: "",
      model: "whisper-large-v3-turbo",
      transcriptionMode: "providers",
    },
    {
      provider: "custom",
      apiKey: "ck-custom",
      baseUrl: "https://gateway.example.test/v1",
      model: "custom-whisper",
      transcriptionMode: "providers",
    },
    {
      provider: "openai",
      apiKey: "",
      baseUrl: "",
      model: "private-whisper",
      transcriptionMode: "self-hosted",
      remoteTranscriptionUrl: "https://stt.internal.example.test",
      remoteTranscriptionModel: "private-whisper",
    },
  ];
  const observedSignals = [];
  fetchResponse = (_url, init) =>
    new Promise((_resolve, reject) => {
      observedSignals.push(init.signal);
      const rejectAbort = () => {
        const error = new Error("aborted provider request");
        error.name = "AbortError";
        reject(error);
      };
      if (init.signal?.aborted) rejectAbort();
      else init.signal?.addEventListener("abort", rejectAbort, { once: true });
    });
  try {
    for (const [index, route] of routes.entries()) {
      const requestId = `dictation-cancel-${index}`;
      const priorFetchCount = fetches.length;
      const operation = invokeUpload({ ...route, requestId });
      while (fetches.length === priorFetchCount) {
        await new Promise((resolve) => setImmediate(resolve));
      }

      const cancelled = await handlers.get("cancel-upload-transcription")(
        { sender: {} },
        requestId
      );
      assert.equal(cancelled.success, true, route.transcriptionMode || route.provider);
      assert.equal(observedSignals.at(-1).aborted, true, route.transcriptionMode || route.provider);
      const result = await operation;
      assert.deepEqual(
        { success: result.success, code: result.code },
        { success: false, code: "UPLOAD_CANCELLED" },
        route.transcriptionMode || route.provider
      );
    }
  } finally {
    fetchResponse = () => ({
      ok: true,
      status: 200,
      json: async () => ({ text: "transcribed" }),
      text: async () => JSON.stringify({ text: "transcribed" }),
    });
  }
});

test("upload: cancellation aborts Corti and Tinfoil provider work in flight", async (t) => {
  await t.test("Corti", () =>
    assertInFlightUploadCancellation({
      requestId: "corti-upload-cancel",
      payload: {
        apiKey: "",
        baseUrl: "",
        model: "corti-transcribe",
        provider: "corti",
        language: "en",
        environment: "eu",
        tenant: "acme",
        transcriptionMode: "providers",
      },
      calls: cortiCalls,
      setBehavior: (behavior) => {
        cortiBehavior = behavior;
      },
    })
  );

  await t.test("Tinfoil", () =>
    assertInFlightUploadCancellation({
      requestId: "tinfoil-upload-cancel",
      payload: {
        apiKey: "",
        baseUrl: "",
        model: "voxtral-small-24b",
        provider: "tinfoil",
        language: "en",
        transcriptionMode: "providers",
      },
      calls: tinfoilCalls,
      setBehavior: (behavior) => {
        tinfoilBehavior = behavior;
      },
    })
  );
});

// Providers that require a concrete language still receive one.
test("upload: corti and xai still get their language", async () => {
  fetches.length = 0;
  const xai = await invokeUpload({
    apiKey: "xk-key",
    baseUrl: "",
    model: "grok-stt",
    provider: "xai",
    language: "de",
    transcriptionMode: "providers",
  });
  assert.equal(xai.success, true);
  assert.match(fetches[0].url, /api\.x\.ai/);
  const xaiBody = fetches[0].init.body.toString();
  assert.match(xaiBody, /name="language"[\s\S]*?de/);
  assert.doesNotMatch(xaiBody, /name="model"/);

  const corti = await invokeUpload({
    apiKey: "",
    baseUrl: "",
    model: "corti-transcribe",
    provider: "corti",
    language: "",
    environment: "eu",
    tenant: " acme ",
    transcriptionMode: "providers",
  });
  assert.equal(corti.success, true);
  assert.equal(cortiCalls.at(-1).language, "en", "corti needs a concrete primaryLanguage");
  assert.equal(cortiCalls.at(-1).environment, "eu");
  assert.equal(cortiCalls.at(-1).tenant, "acme");
});

// #1459 made cloudTranscriptionBaseUrl Custom-only, so provider id alone can no
// longer tell whether a Custom endpoint fronts a diarization-capable API.
test("upload: a Custom endpoint fronting OpenAI or Mistral keeps diarization", async () => {
  fetches.length = 0;
  const openaiFronted = await invokeUpload({
    apiKey: "ck-custom",
    baseUrl: "https://api.openai.com/v1/audio/transcriptions",
    model: "whisper-1",
    provider: "custom",
    diarize: true,
    language: "",
    transcriptionMode: "providers",
  });
  assert.equal(openaiFronted.success, true);
  assert.match(fetches[0].init.body.toString(), /gpt-4o-transcribe-diarize/);

  fetches.length = 0;
  const mistralFronted = await invokeUpload({
    apiKey: "ck-custom",
    baseUrl: "https://api.mistral.ai/v1/audio/transcriptions",
    model: "voxtral-mini-latest",
    provider: "custom",
    diarize: true,
    language: "",
    transcriptionMode: "providers",
  });
  assert.equal(mistralFronted.success, true);
  assert.match(fetches[0].init.body.toString(), /name="diarize"/);

  fetches.length = 0;
  const unknownGateway = await invokeUpload({
    apiKey: "ck-custom",
    baseUrl: "https://gateway.example.com/v1",
    model: "whisper-1",
    provider: "custom",
    diarize: true,
    language: "",
    transcriptionMode: "providers",
  });
  assert.equal(unknownGateway.success, true, "an unknown gateway degrades, never fails");
  assert.doesNotMatch(fetches[0].init.body.toString(), /diarized_json/);
});

test("upload: a self-hosted Azure endpoint keeps its deployment URL", async () => {
  fetches.length = 0;
  const result = await invokeUpload({
    apiKey: "",
    baseUrl: "",
    model: "",
    provider: "custom",
    language: "",
    transcriptionMode: "self-hosted",
    remoteTranscriptionUrl: "https://myorg.openai.azure.com",
    remoteTranscriptionModel: "my-deployment",
  });
  assert.equal(result.success, true);
  assert.equal(
    fetches[0].url,
    "https://myorg.openai.azure.com/openai/deployments/my-deployment/audio/transcriptions?api-version=2025-03-01-preview"
  );
});

const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const fs = require("node:fs");

const handlersModulePath = require.resolve("../../src/helpers/ipcHandlers");
const { createUploadCancelRegistry } = require("../../src/helpers/uploadCancelRegistry");
const originalLoad = Module._load;
const originalApiUrl = process.env.OPENWHISPR_API_URL;
process.env.OPENWHISPR_API_URL = "https://api.example.com";
const handlers = new Map();
const dispatches = [];
const fetches = [];
const downstreamTouches = [];
const tokenListeners = new Set();
let tokenState = { token: null, generation: 0 };
let enterpriseConfigBehavior = async () => null;
let enterpriseConfigCalls = 0;
let managedLocalArtifactStatus = async () => ({ success: true, downloaded: true });
let IPCHandlers;
let downstreamProbeArmed = false;

function recordDownstreamTouch(label) {
  if (!downstreamProbeArmed) return;
  downstreamTouches.push(label);
  throw Object.assign(new Error(`Downstream work started before authorization: ${label}`), {
    code: "TEST_DOWNSTREAM_BEFORE_AUTH",
  });
}

function probeCallable(label, callable) {
  return new Proxy(callable, {
    apply(target, thisArg, args) {
      recordDownstreamTouch(label);
      return Reflect.apply(target, thisArg, args);
    },
    construct(target, args, newTarget) {
      recordDownstreamTouch(label);
      return Reflect.construct(target, args, newTarget);
    },
  });
}

const probedFs = new Proxy(fs, {
  get(target, property, receiver) {
    const value = Reflect.get(target, property, receiver);
    return typeof value === "function"
      ? probeCallable(`fs.${String(property)}`, value.bind(target))
      : value;
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
    handle: (channel, handler) => handlers.set(channel, handler),
    on: () => {},
    removeHandler: () => {},
  },
  net: {
    fetch: async (...args) => {
      recordDownstreamTouch("electron.net.fetch");
      fetches.push(args);
      return { ok: true, status: 200, json: async () => ({ text: "unexpected" }) };
    },
  },
  BrowserWindow: class BrowserWindow {
    static getAllWindows() {
      return [];
    }
    static fromWebContents(webContents) {
      return webContents?.ownerWindow ?? null;
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
  if (parent?.filename === handlersModulePath) {
    if (request === "fs") return probedFs;
    if (request === "./debugLogger") {
      return { debug() {}, error() {}, log() {}, warn() {} };
    }
    if (request === "./tokenStore") {
      return {
        get: () => tokenState.token,
        getState: () => ({ ...tokenState }),
        subscribe: (listener) => {
          tokenListeners.add(listener);
          return () => tokenListeners.delete(listener);
        },
      };
    }
    if (request === "./enterpriseIdentityManager") {
      return {
        createEnterpriseIdentityManager: () => ({
          clear() {},
          getConfig: (request) => {
            enterpriseConfigCalls += 1;
            return enterpriseConfigBehavior(request);
          },
          resolveProvider: async () => ({ managed: false }),
        }),
      };
    }
    if (request === "./meetingTranscriptionLifecycle") {
      return () => ({
        abortSession: async () => ({ success: true }),
        startSession: async () => {
          recordDownstreamTouch("meeting.startSession");
          dispatches.push("meeting-start");
          return { success: true };
        },
        stopSession: async () => ({ success: true }),
      });
    }
    if (
      [
        "./assemblyAiStreaming",
        "./deepgramStreaming",
        "./cortiStreaming",
        "./openaiRealtimeStreaming",
      ].includes(request)
    ) {
      return probeCallable(request, originalLoad.call(this, request, parent, isMain));
    }
    if (
      [
        "./cortiAuth",
        "./realtimeTokenProviders",
        "./tinfoilSecureClient",
        "./tinfoilTranscription",
        "./cortiTranscription",
      ].includes(request)
    ) {
      const loaded = originalLoad.call(this, request, parent, isMain);
      return Object.fromEntries(
        Object.entries(loaded).map(([name, value]) => [
          name,
          typeof value === "function" ? probeCallable(`${request}.${name}`, value) : value,
        ])
      );
    }
    if (request === "./windowBroadcast") return { broadcastToWindows: () => {} };
  }
  return originalLoad.call(this, request, parent, isMain);
};

function anything(label = "context") {
  return new Proxy(function inert() {}, {
    get: (_target, property) => {
      if (property === Symbol.toPrimitive || property === "toString") return () => "";
      if (property === "then") return undefined;
      return anything(`${label}.${String(property)}`);
    },
    apply: () => {
      recordDownstreamTouch(label);
      return anything(label);
    },
  });
}

function buildContext() {
  const target = {
    sessionId: "test-session",
    _uploadCancelRegistry: createUploadCancelRegistry(),
    _cloudTranscriptionRequests: {
      begin: () => ({ signal: { aborted: false } }),
      cancelSender() {},
      complete() {},
    },
    audioStorageManager: { getAudioBuffer: () => Buffer.from([1, 2, 3]) },
    databaseManager: {
      getTranscriptionById: () => {
        recordDownstreamTouch("databaseManager.getTranscriptionById");
        return { id: 7 };
      },
    },
    environmentManager: anything("environmentManager"),
    whisperManager: {
      serverManager: {
        isAvailable: () => {
          recordDownstreamTouch("whisper.serverManager.isAvailable");
          return true;
        },
      },
      checkModelStatus: (...args) => {
        recordDownstreamTouch("whisper.checkModelStatus");
        return managedLocalArtifactStatus(...args);
      },
      transcribeLocalWhisper: async () => {
        recordDownstreamTouch("whisper.transcribeLocalWhisper");
        dispatches.push("whisper");
        return { success: true, text: "unexpected" };
      },
    },
    parakeetManager: {
      supportsOnlineStreaming: () => {
        recordDownstreamTouch("parakeet.supportsOnlineStreaming");
        return false;
      },
      checkModelStatus: (...args) => {
        recordDownstreamTouch("parakeet.checkModelStatus");
        return managedLocalArtifactStatus(...args);
      },
      transcribeLocalParakeet: async () => {
        recordDownstreamTouch("parakeet.transcribeLocalParakeet");
        dispatches.push("parakeet");
        return { success: true, text: "unexpected" };
      },
    },
    windowManager: {
      showTranscriptionPreview: () => {
        recordDownstreamTouch("windowManager.showTranscriptionPreview");
        dispatches.push("preview");
      },
      hideTranscriptionPreview() {
        recordDownstreamTouch("windowManager.hideTranscriptionPreview");
      },
    },
  };
  return new Proxy(target, {
    get: (current, property) =>
      property in current ? current[property] : anything(`context.${String(property)}`),
  });
}

const managedClaim = (provider, model, managed = false, workspaceId = "workspace-a") => ({
  accountId: "account-a",
  workspaceId,
  authGeneration: 7,
  configGeneration: workspaceId === "workspace-a" ? 11 : 22,
  managed,
  provider,
  model,
});

const configResult = (workspaceId, generation, model) => ({
  success: true,
  accountId: "account-a",
  workspaceId,
  authGeneration: 7,
  config: {
    workspaceId,
    generation,
    providers: [],
    localModels: { selections: [{ provider: "whisper", model }] },
  },
});

let context;
test.before(() => {
  delete require.cache[handlersModulePath];
  IPCHandlers = require(handlersModulePath);
  context = buildContext();
  IPCHandlers.prototype.setupHandlers.call(context);
});

test.after(() => {
  Module._load = originalLoad;
  if (originalApiUrl === undefined) delete process.env.OPENWHISPR_API_URL;
  else process.env.OPENWHISPR_API_URL = originalApiUrl;
});

test.beforeEach(() => {
  context._clearActiveEnterpriseIdentity?.();
  context.windowManager.mainWindow = undefined;
  context._dictationStreaming = null;
  dispatches.length = 0;
  fetches.length = 0;
  downstreamTouches.length = 0;
  downstreamProbeArmed = false;
  tokenListeners.clear();
  tokenState = { token: null, generation: 0 };
  enterpriseConfigBehavior = async () => null;
  enterpriseConfigCalls = 0;
  managedLocalArtifactStatus = async () => ({ success: true, downloaded: true });
});

function senderWithCookies(id, getCookies) {
  const sender = { id, once() {}, removeListener() {}, send() {}, isDestroyed: () => false };
  sender.ownerWindow = {
    webContents: {
      session: { cookies: { get: async () => getCookies() } },
    },
  };
  return sender;
}

async function activateWorkspace(workspaceId = "workspace-a", generation = 11, model = "small") {
  tokenState = { token: "session", generation: 7 };
  const mainSender = { id: 1 };
  context.windowManager.mainWindow = { webContents: mainSender };
  enterpriseConfigBehavior = async () => configResult(workspaceId, generation, model);
  await handlers.get("get-managed-enterprise-config")(
    { sender: mainSender },
    "account-a",
    workspaceId,
    7
  );
  return mainSender;
}

test("managed rejection leaves every transcription start family undispatched", async (t) => {
  await activateWorkspace();
  const sender = { id: 2, once() {}, removeListener() {}, send() {}, isDestroyed: () => false };
  const rows = [
    [
      "dictation batch",
      "cloud-transcribe",
      [new ArrayBuffer(4), {}, managedClaim("openwhispr", null)],
    ],
    [
      "direct HTTP preflight",
      "authorize-transcription-start",
      [{ provider: "openai", model: "whisper-1" }, managedClaim("openai", "whisper-1")],
    ],
    [
      "dictation warmup",
      "dictation-realtime-warmup",
      [
        { provider: "openai-realtime", model: "gpt-4o-mini-transcribe" },
        managedClaim("openai-realtime", "gpt-4o-mini-transcribe"),
      ],
    ],
    [
      "preview",
      "start-dictation-preview",
      [
        { provider: "nvidia", model: "parakeet-tdt-0.6b-v3", display: false },
        managedClaim("nvidia", "parakeet-tdt-0.6b-v3"),
      ],
    ],
    [
      "realtime",
      "dictation-realtime-start",
      [
        { provider: "openai-realtime", model: "gpt-4o-mini-transcribe" },
        managedClaim("openai-realtime", "gpt-4o-mini-transcribe"),
      ],
    ],
    [
      "cloud file upload",
      "transcribe-audio-file-cloud",
      ["/tmp/not-read.webm", {}, managedClaim("openwhispr", null)],
    ],
    [
      "local file upload",
      "transcribe-audio-file",
      [
        "/tmp/not-read.webm",
        { provider: "nvidia", model: "parakeet-tdt-0.6b-v3" },
        managedClaim("nvidia", "parakeet-tdt-0.6b-v3"),
      ],
    ],
    [
      "upload",
      "transcribe-audio-file-byok",
      [
        {
          filePath: "/tmp/not-read.webm",
          provider: "openai",
          model: "gpt-4o-mini-transcribe",
          transcriptionMode: "providers",
        },
        managedClaim("openai", "gpt-4o-mini-transcribe"),
      ],
    ],
    [
      "xAI proxy",
      "proxy-xai-transcription",
      [{ audioBuffer: new ArrayBuffer(4) }, managedClaim("xai", "grok-stt")],
    ],
    [
      "Mistral proxy",
      "proxy-mistral-transcription",
      [
        { audioBuffer: new ArrayBuffer(4), model: "voxtral-mini-latest" },
        managedClaim("mistral", "voxtral-mini-latest"),
      ],
    ],
    [
      "Corti proxy",
      "proxy-corti-transcription",
      [
        { audioBuffer: new ArrayBuffer(4), language: "en" },
        managedClaim("corti", "corti-transcribe"),
      ],
    ],
    [
      "Tinfoil proxy",
      "proxy-tinfoil-transcription",
      [{ audioBuffer: new ArrayBuffer(4) }, managedClaim("tinfoil", "voxtral-small-24b")],
    ],
    [
      "AssemblyAI warmup",
      "assemblyai-streaming-warmup",
      [{ model: "best" }, managedClaim("assemblyai", "best")],
    ],
    [
      "AssemblyAI start",
      "assemblyai-streaming-start",
      [{ model: "best" }, managedClaim("assemblyai", "best")],
    ],
    [
      "Deepgram warmup",
      "deepgram-streaming-warmup",
      [{ model: "nova-3" }, managedClaim("deepgram", "nova-3")],
    ],
    [
      "Deepgram start",
      "deepgram-streaming-start",
      [{ model: "nova-3" }, managedClaim("deepgram", "nova-3")],
    ],
    [
      "Corti warmup",
      "corti-streaming-warmup",
      [{ model: "corti-transcribe" }, managedClaim("corti", "corti-transcribe")],
    ],
    [
      "Corti start",
      "corti-streaming-start",
      [{ model: "corti-transcribe" }, managedClaim("corti", "corti-transcribe")],
    ],
    [
      "history",
      "retry-transcription",
      [
        7,
        {
          useLocalWhisper: false,
          cloudTranscriptionMode: "openwhispr",
          transcriptionMode: "providers",
        },
        managedClaim("openwhispr", null),
      ],
    ],
    [
      "meeting prepare",
      "meeting-transcription-prepare",
      [
        { provider: "local", localProvider: "nvidia", localModel: "parakeet-tdt-0.6b-v3" },
        managedClaim("nvidia", "parakeet-tdt-0.6b-v3"),
      ],
    ],
    [
      "meeting start",
      "meeting-transcription-start",
      [
        {
          provider: "local",
          localProvider: "nvidia",
          localModel: "parakeet-tdt-0.6b-v3",
          sessionId: "meeting-a",
        },
        managedClaim("nvidia", "parakeet-tdt-0.6b-v3"),
      ],
    ],
    [
      "direct local decode",
      "transcribe-local-parakeet",
      [
        new ArrayBuffer(4),
        { model: "parakeet-tdt-0.6b-v3" },
        managedClaim("nvidia", "parakeet-tdt-0.6b-v3"),
      ],
    ],
  ];

  for (const [name, channel, args] of rows) {
    await t.test(name, async () => {
      dispatches.length = 0;
      fetches.length = 0;
      downstreamTouches.length = 0;
      let result;
      try {
        downstreamProbeArmed = true;
        result = await handlers.get(channel)({ sender }, ...args);
      } finally {
        downstreamProbeArmed = false;
      }
      assert.notEqual(result.success, true);
      assert.equal(result.code, "AUTHORIZATION_BOUNDARY_CHANGED");
      assert.deepEqual(downstreamTouches, []);
      assert.deepEqual(dispatches, []);
      assert.deepEqual(fetches, []);
    });
  }
});

test("unavailable exact managed local artifacts reject every local start before dispatch", async (t) => {
  const sender = { id: 2, once() {}, removeListener() {}, isDestroyed: () => false };
  const rows = [
    [
      "file diarization preflight",
      "authorize-transcription-start",
      [{ provider: "whisper", model: "small" }, managedClaim("whisper", "small", true)],
    ],
    [
      "direct decode",
      "transcribe-local-whisper",
      [new ArrayBuffer(4), { model: "small" }, managedClaim("whisper", "small", true)],
    ],
    [
      "file decode",
      "transcribe-audio-file",
      [
        "/tmp/not-read.webm",
        { provider: "whisper", model: "small" },
        managedClaim("whisper", "small", true),
      ],
    ],
    [
      "preview warm stream",
      "start-dictation-preview",
      [
        { provider: "whisper", model: "small", display: false },
        managedClaim("whisper", "small", true),
      ],
    ],
    [
      "meeting prepare",
      "meeting-transcription-prepare",
      [
        { provider: "local", localProvider: "whisper", localModel: "small" },
        managedClaim("whisper", "small", true),
      ],
    ],
    [
      "meeting start",
      "meeting-transcription-start",
      [
        {
          provider: "local",
          localProvider: "whisper",
          localModel: "small",
          sessionId: "meeting-artifact-check",
        },
        managedClaim("whisper", "small", true),
      ],
    ],
  ];

  const statusFailures = [
    ["download missing", async () => ({ success: true, downloaded: false })],
    ["malformed status", async () => undefined],
    [
      "status check throws",
      async () => {
        throw new Error("model status transport failed");
      },
    ],
  ];

  for (const [statusName, statusBehavior] of statusFailures) {
    for (const [routeName, channel, args] of rows) {
      await t.test(`${statusName}: ${routeName}`, async () => {
        await activateWorkspace();
        managedLocalArtifactStatus = statusBehavior;
        dispatches.length = 0;
        fetches.length = 0;
        const result = await handlers.get(channel)({ sender }, ...args);
        assert.equal(result.success, false);
        assert.equal(result.code, "MANAGED_LOCAL_MODEL_UNAVAILABLE");
        assert.equal(result.error, "Managed local transcription model is unavailable.");
        assert.deepEqual(dispatches, []);
        assert.deepEqual(fetches, []);
      });
    }
  }
});

test("only the main window may replace active identity and late workspaces lose", async () => {
  const mainSender = await activateWorkspace();
  enterpriseConfigBehavior = async ({ workspaceId }) => configResult(workspaceId, 22, "base");
  await handlers.get("get-managed-enterprise-config")(
    { sender: { id: 9 } },
    "account-a",
    "workspace-b",
    7
  );
  enterpriseConfigBehavior = async () => configResult("workspace-a", 11, "small");

  const secondaryResult = await handlers.get("transcribe-local-whisper")(
    { sender: { id: 2 } },
    new ArrayBuffer(4),
    { model: "small" },
    managedClaim("whisper", "small", true)
  );
  assert.equal(secondaryResult.success, true);

  let resolveA;
  let resolveB;
  const pendingAConfig = new Promise((resolve) => {
    resolveA = resolve;
  });
  const pendingBConfig = new Promise((resolve) => {
    resolveB = resolve;
  });
  enterpriseConfigBehavior = ({ workspaceId }) =>
    workspaceId === "workspace-a" ? pendingAConfig : pendingBConfig;
  const pendingA = handlers.get("get-managed-enterprise-config")(
    { sender: mainSender },
    "account-a",
    "workspace-a",
    7,
    true
  );
  const pendingB = handlers.get("get-managed-enterprise-config")(
    { sender: mainSender },
    "account-a",
    "workspace-b",
    7,
    true
  );
  resolveB(configResult("workspace-b", 22, "base"));
  await pendingB;
  resolveA(configResult("workspace-a", 11, "small"));
  await pendingA;

  dispatches.length = 0;
  const stale = await handlers.get("transcribe-local-whisper")(
    { sender: { id: 2 } },
    new ArrayBuffer(4),
    { model: "small" },
    managedClaim("whisper", "small", true)
  );
  assert.equal(stale.success, false);
  assert.equal(stale.code, "AUTHORIZATION_BOUNDARY_CHANGED");
  assert.deepEqual(dispatches, []);

  enterpriseConfigBehavior = async () => configResult("workspace-b", 22, "base");
  const current = await handlers.get("transcribe-local-whisper")(
    { sender: { id: 2 } },
    new ArrayBuffer(4),
    { model: "base" },
    managedClaim("whisper", "base", true, "workspace-b")
  );
  assert.equal(current.success, true);
  assert.deepEqual(dispatches, ["whisper"]);
});

test("token changes during header resolution install no identity", async () => {
  const mainSender = { id: 1 };
  context.windowManager.mainWindow = { webContents: mainSender };
  tokenState = { token: null, generation: 7 };
  const pending = handlers.get("get-managed-enterprise-config")(
    { sender: mainSender },
    "account-a",
    "workspace-a",
    7
  );
  tokenState = { token: "replacement", generation: 8 };
  await pending;

  const result = await handlers.get("transcribe-local-whisper")(
    { sender: { id: 2 } },
    new ArrayBuffer(4),
    { model: "small" },
    managedClaim("whisper", "small", true)
  );
  assert.equal(result.success, false);
  assert.equal(result.code, "AUTHORIZATION_BOUNDARY_CHANGED");
});

test("signed-in explicit clear blocks the old identity before config lookup", async () => {
  const mainSender = await activateWorkspace();
  await handlers.get("clear-managed-enterprise-identity")({ sender: mainSender });
  const configCallsBeforeStart = enterpriseConfigCalls;
  const result = await handlers.get("transcribe-local-whisper")(
    { sender: { id: 2 } },
    new ArrayBuffer(4),
    { model: "small" },
    managedClaim("whisper", "small", true)
  );
  assert.equal(result.success, false);
  assert.equal(result.code, "AUTHORIZATION_BOUNDARY_CHANGED");
  assert.equal(enterpriseConfigCalls, configCallsBeforeStart);
  assert.deepEqual(dispatches, []);
});

test("production token subscription clears installed identity on rotation and sign-out", async () => {
  assert.equal(typeof IPCHandlers.subscribeEnterpriseIdentityInvalidation, "function");
  IPCHandlers.subscribeEnterpriseIdentityInvalidation({
    tokenStore: {
      subscribe: (listener) => {
        tokenListeners.add(listener);
        return () => tokenListeners.delete(listener);
      },
    },
    clearActiveIdentity: context._clearActiveEnterpriseIdentity,
    clearConfig: () => context.enterpriseIdentityManager.clear(),
    broadcast: () => {},
  });
  for (const nextTokenState of [
    { token: "replacement", generation: 8 },
    { token: null, generation: 9 },
  ]) {
    await activateWorkspace();
    tokenState = nextTokenState;
    for (const listener of tokenListeners) listener(tokenState);

    const configCallsBeforeStart = enterpriseConfigCalls;
    const result = await handlers.get("transcribe-local-whisper")(
      { sender: { id: 2 } },
      new ArrayBuffer(4),
      { model: "small" },
      managedClaim("whisper", "small", true)
    );
    assert.equal(result.success, false);
    assert.equal(result.code, "AUTHORIZATION_BOUNDARY_CHANGED");
    assert.equal(enterpriseConfigCalls, configCallsBeforeStart);
    assert.deepEqual(dispatches, []);
  }
});

test("cookie rotation without token generation change rejects before config or dispatch", async () => {
  let cookies = [{ name: "session", value: "first" }];
  tokenState = { token: null, generation: 7 };
  const mainSender = senderWithCookies(1, () => cookies);
  context.windowManager.mainWindow = { webContents: mainSender };
  enterpriseConfigBehavior = async () => configResult("workspace-a", 11, "small");
  await handlers.get("get-managed-enterprise-config")(
    { sender: mainSender },
    "account-a",
    "workspace-a",
    7
  );
  cookies = [{ name: "session", value: "second" }];
  const configCallsBeforeStart = enterpriseConfigCalls;

  const result = await handlers.get("transcribe-local-whisper")(
    { sender: mainSender },
    new ArrayBuffer(4),
    { model: "small" },
    managedClaim("whisper", "small", true)
  );
  assert.equal(result.success, false);
  assert.equal(result.code, "AUTHORIZATION_BOUNDARY_CHANGED");
  assert.equal(enterpriseConfigCalls, configCallsBeforeStart);
  assert.deepEqual(dispatches, []);
});

test("API origin change rejects before config or dispatch", async () => {
  const mainSender = await activateWorkspace();
  const configCallsBeforeStart = enterpriseConfigCalls;
  process.env.OPENWHISPR_API_URL = "https://rotated.example.com/path";

  const result = await handlers.get("transcribe-local-whisper")(
    { sender: mainSender },
    new ArrayBuffer(4),
    { model: "small" },
    managedClaim("whisper", "small", true)
  );
  process.env.OPENWHISPR_API_URL = "https://api.example.com";
  assert.equal(result.success, false);
  assert.equal(result.code, "AUTHORIZATION_BOUNDARY_CHANGED");
  assert.equal(enterpriseConfigCalls, configCallsBeforeStart);
  assert.deepEqual(dispatches, []);
});

test("same-identity refresh preserves an in-flight admission object", async () => {
  const mainSender = await activateWorkspace();
  const activeBeforeRefresh = context._getActiveEnterpriseIdentity?.();
  assert.ok(activeBeforeRefresh);
  let resolveStart;
  const startConfig = new Promise((resolve) => {
    resolveStart = resolve;
  });
  enterpriseConfigBehavior = async (request) =>
    request.forceRefresh ? configResult("workspace-a", 11, "small") : startConfig;
  const pendingStart = handlers.get("transcribe-local-whisper")(
    { sender: { id: 2 } },
    new ArrayBuffer(4),
    { model: "small" },
    managedClaim("whisper", "small", true)
  );
  await handlers.get("get-managed-enterprise-config")(
    { sender: mainSender },
    "account-a",
    "workspace-a",
    7,
    true
  );
  assert.equal(context._getActiveEnterpriseIdentity(), activeBeforeRefresh);
  resolveStart(configResult("workspace-a", 11, "small"));
  const result = await pendingStart;
  assert.equal(result.success, true);
  assert.deepEqual(dispatches, ["whisper"]);
});

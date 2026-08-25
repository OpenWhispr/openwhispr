const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

const handlersModulePath = require.resolve("../../src/helpers/ipcHandlers");
const originalLoad = Module._load;
const originalApiUrl = process.env.OPENWHISPR_API_URL;
process.env.OPENWHISPR_API_URL = "https://api.example.com";

const invokeHandlers = new Map();
const eventHandlers = new Map();
const dispatches = [];
const fetches = [];
let tokenState = { token: null, generation: 0 };
let enterpriseConfigBehavior = async () => null;
let enterpriseProviderBehavior = async () => ({ managed: false });
let enterpriseProviderCalls = 0;
let managedReasoningArtifactDownloaded = true;
let anthropicCredentialReads = 0;
let IPCHandlers;

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
    handle: (channel, handler) => invokeHandlers.set(channel, handler),
    on: (channel, handler) => eventHandlers.set(channel, handler),
    removeHandler() {},
  },
  net: {
    fetch: async (...args) => {
      fetches.push(args);
      return {
        ok: true,
        status: 200,
        body: new ReadableStream({ start: (controller) => controller.close() }),
        json: async () => ({ content: [{ text: "unexpected" }] }),
      };
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
    if (request === "./debugLogger") {
      return { debug() {}, error() {}, log() {}, warn() {}, info() {} };
    }
    if (request === "./tokenStore") {
      return {
        get: () => tokenState.token,
        getState: () => ({ ...tokenState }),
        subscribe: () => () => {},
      };
    }
    if (request === "./enterpriseIdentityManager") {
      return {
        createEnterpriseIdentityManager: () => ({
          clear() {},
          getConfig: (requestInput) => enterpriseConfigBehavior(requestInput),
          resolveProvider: (requestInput) => {
            enterpriseProviderCalls += 1;
            return enterpriseProviderBehavior(requestInput);
          },
        }),
      };
    }
    if (request === "./modelManagerBridge") {
      return {
        default: {
          isModelDownloaded: async (model) => {
            dispatches.push(`artifact:${model}`);
            if (managedReasoningArtifactDownloaded instanceof Error) {
              throw managedReasoningArtifactDownloaded;
            }
            return managedReasoningArtifactDownloaded;
          },
        },
      };
    }
    if (request === "../services/localReasoningBridge") {
      return {
        default: {
          processText: async () => {
            dispatches.push("local");
            return "unexpected";
          },
          isAvailable: async () => true,
        },
      };
    }
    if (request === "./enterpriseAiProviders") {
      return {
        getEnterpriseAIModel: () => {
          dispatches.push("enterprise-model");
          return {
            doStream: async () => ({
              stream: new ReadableStream({ start: (controller) => controller.close() }),
            }),
          };
        },
      };
    }
    if (request === "./meetingTranscriptionLifecycle") {
      return () => ({
        abortSession: async () => ({ success: true }),
        startSession: async () => ({ success: true }),
        stopSession: async () => ({ success: true }),
      });
    }
    if (request === "./windowBroadcast") return { broadcastToWindows() {} };
  }
  if (request === "ai" && parent?.filename === handlersModulePath) {
    return {
      generateText: async () => {
        dispatches.push("enterprise-generate");
        return { text: "unexpected", finishReason: "stop" };
      },
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};

function anything() {
  return new Proxy(function inert() {}, {
    get: (_target, property) => {
      if (property === Symbol.toPrimitive || property === "toString") return () => "";
      if (property === "then") return undefined;
      return anything();
    },
    apply: () => anything(),
  });
}

function buildContext() {
  const target = {
    sessionId: "test-session",
    _cloudReasonRequests: {
      begin: () => ({ signal: { aborted: false } }),
      cancelSender() {},
      complete() {},
    },
    _agentStreamRequests: {
      begin: () => ({ signal: { aborted: false } }),
      cancel() {},
      cancelSender() {},
      complete() {},
    },
    environmentManager: {
      getAnthropicKey: () => {
        anthropicCredentialReads += 1;
        return "anthropic-key";
      },
    },
    whisperManager: {},
    parakeetManager: {},
    windowManager: {},
  };
  return new Proxy(target, {
    get: (current, property) => (property in current ? current[property] : anything()),
  });
}

function managedLocalResult() {
  return {
    success: true,
    accountId: "account-a",
    workspaceId: "workspace-a",
    authGeneration: 7,
    config: {
      workspaceId: "workspace-a",
      generation: 11,
      providers: [],
      localModels: {
        selections: [{ provider: "qwen", model: "qwen3.5-4b-q4_k_m" }],
      },
    },
  };
}

const reasoningClaim = (provider, model, managed = false) => ({
  accountId: "account-a",
  workspaceId: "workspace-a",
  authGeneration: 7,
  configGeneration: 11,
  managed,
  provider,
  model,
});

function reasoningConfig(provider) {
  return {
    provider,
    inferenceScope: "chatIntelligence",
    setupMode: "auto",
  };
}

function createSender(id = 2) {
  const sent = [];
  return {
    id,
    sent,
    once() {},
    on() {},
    removeListener() {},
    send: (channel, payload) => sent.push([channel, payload]),
    isDestroyed: () => false,
  };
}

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
  tokenState = { token: null, generation: 0 };
  enterpriseConfigBehavior = async () => null;
  enterpriseProviderBehavior = async () => ({ managed: false });
  enterpriseProviderCalls = 0;
  managedReasoningArtifactDownloaded = true;
  anthropicCredentialReads = 0;
  dispatches.length = 0;
  fetches.length = 0;
});

async function activateManagedLocal() {
  tokenState = { token: "session", generation: 7 };
  const mainSender = createSender(1);
  context.windowManager.mainWindow = { webContents: mainSender };
  enterpriseConfigBehavior = async () => managedLocalResult();
  await invokeHandlers.get("get-managed-enterprise-config")(
    { sender: mainSender },
    "account-a",
    "workspace-a",
    7
  );
}

async function activateManagedCloud() {
  tokenState = { token: "session", generation: 7 };
  const mainSender = createSender(1);
  context.windowManager.mainWindow = { webContents: mainSender };
  enterpriseConfigBehavior = async () => ({
    success: true,
    accountId: "account-a",
    workspaceId: "workspace-a",
    authGeneration: 7,
    config: {
      workspaceId: "workspace-a",
      generation: 11,
      identity: {},
      providers: [
        {
          provider: "bedrock",
          mode: "managed_required",
          allowManualSetup: false,
          version: 3,
          config: {
            roleArn: "arn:aws:iam::123456789012:role/OpenWhispr",
            region: "us-east-1",
            allowedModels: ["managed-model"],
            scopeDefaults: {
              dictationCleanup: "managed-model",
              dictationAgent: "managed-model",
              noteFormatting: "managed-model",
              chatIntelligence: "managed-model",
              dictationTranslation: "managed-model",
            },
          },
        },
      ],
    },
  });
  enterpriseProviderBehavior = async () => ({
    managed: true,
    identity: { accountId: "account-a", workspaceId: "workspace-a", authGeneration: 7 },
    provider: "bedrock",
    model: "managed-model",
    config: { region: "us-east-1" },
    version: 3,
    generation: 11,
    credentialProvider: async () => ({
      accessKeyId: "managed",
      secretAccessKey: "managed",
    }),
  });
  await invokeHandlers.get("get-managed-enterprise-config")(
    { sender: mainSender },
    "account-a",
    "workspace-a",
    7
  );
}

const guestReasoningClaim = (provider, model) => ({
  accountId: null,
  workspaceId: null,
  authGeneration: null,
  configGeneration: null,
  managed: false,
  provider,
  model,
});

const managedEnterpriseContext = (overrides = {}) => ({
  accountId: "account-a",
  workspaceId: "workspace-a",
  authGeneration: 7,
  generation: 11,
  provider: "bedrock",
  inferenceScope: "chatIntelligence",
  setupMode: "auto",
  providerVersion: 3,
  ...overrides,
});

test("every main-crossing reasoning one-shot and stream rejects before dispatch", async (t) => {
  const sender = createSender();
  const rows = [
    {
      name: "renderer-native central preflight",
      run: () =>
        invokeHandlers.get("authorize-reasoning-start")(
          { sender },
          {
            provider: "custom",
            model: "personal-model",
            inferenceScope: "chatIntelligence",
            setupMode: "auto",
          },
          reasoningClaim("custom", "personal-model")
        ),
      result: (value) => value,
    },
    {
      name: "local one-shot",
      run: () =>
        invokeHandlers.get("process-local-reasoning")(
          { sender },
          "hello",
          "qwen3.5-4b-q4_k_m",
          null,
          reasoningConfig("qwen"),
          reasoningClaim("qwen", "personal-model")
        ),
      result: (value) => value,
    },
    {
      name: "Anthropic one-shot",
      run: () =>
        invokeHandlers.get("process-anthropic-reasoning")(
          { sender },
          "hello",
          "claude-personal",
          null,
          reasoningConfig("anthropic"),
          reasoningClaim("anthropic", "claude-personal")
        ),
      result: (value) => value,
    },
    {
      name: "enterprise one-shot",
      run: () =>
        invokeHandlers.get("process-enterprise-reasoning")(
          { sender },
          "hello",
          "deployment-personal",
          null,
          reasoningConfig("azure"),
          reasoningClaim("azure", "deployment-personal")
        ),
      result: (value) => value,
    },
    {
      name: "enterprise stream",
      run: () =>
        invokeHandlers.get("enterprise-stream-start")(
          { sender },
          {
            streamId: "stream-a",
            provider: "azure",
            modelId: "deployment-personal",
            config: reasoningConfig("azure"),
            options: {},
          },
          reasoningClaim("azure", "deployment-personal")
        ),
      result: (value) => value,
    },
    {
      name: "OpenWhispr one-shot",
      run: () =>
        invokeHandlers.get("cloud-reason")(
          { sender },
          "hello",
          { inferenceScope: "dictationCleanup", setupMode: "auto" },
          reasoningClaim("openwhispr", null)
        ),
      result: (value) => value,
    },
    {
      name: "OpenWhispr agent stream",
      run: async () => {
        await eventHandlers.get("cloud-agent-stream-start")(
          { sender },
          "request-a",
          [{ role: "user", content: "hello" }],
          { inferenceScope: "chatIntelligence", setupMode: "auto" },
          reasoningClaim("openwhispr", null)
        );
        return sender.sent.find(
          ([channel, payload]) =>
            channel === "cloud-agent-stream-error" && payload.requestId === "request-a"
        )?.[1];
      },
      result: (value) => value,
    },
  ];

  for (const row of rows) {
    await t.test(row.name, async () => {
      await activateManagedLocal();
      dispatches.length = 0;
      fetches.length = 0;
      sender.sent.length = 0;
      const result = row.result(await row.run());
      assert.equal(result.success, false);
      assert.equal(result.code, "AUTHORIZATION_BOUNDARY_CHANGED");
      assert.deepEqual(dispatches, []);
      assert.deepEqual(fetches, []);
    });
  }
});

test("a missing signed-in reasoning claim is terminal before every main dispatch", async (t) => {
  const sender = createSender();
  const rows = [
    [
      "local",
      () =>
        invokeHandlers.get("process-local-reasoning")(
          { sender },
          "hello",
          "qwen3.5-4b-q4_k_m",
          null,
          reasoningConfig("qwen")
        ),
    ],
    [
      "Anthropic",
      () =>
        invokeHandlers.get("process-anthropic-reasoning")(
          { sender },
          "hello",
          "claude-personal",
          null,
          reasoningConfig("anthropic")
        ),
    ],
    [
      "OpenWhispr",
      () =>
        invokeHandlers.get("cloud-reason")({ sender }, "hello", {
          inferenceScope: "dictationCleanup",
          setupMode: "auto",
        }),
    ],
  ];

  for (const [name, run] of rows) {
    await t.test(name, async () => {
      await activateManagedLocal();
      dispatches.length = 0;
      fetches.length = 0;
      const result = await run();
      assert.equal(result.success, false);
      assert.equal(result.code, "AUTHORIZATION_BOUNDARY_CHANGED");
      assert.deepEqual(dispatches, []);
      assert.deepEqual(fetches, []);
    });
  }
});

test("main reasoning handlers authorize their fixed runtime instead of hostile config providers", async (t) => {
  const sender = createSender();
  const rows = [
    {
      name: "local derives qwen from the model",
      run: () =>
        invokeHandlers.get("process-local-reasoning")(
          { sender },
          "hello",
          "qwen3.5-4b-q4_k_m",
          null,
          reasoningConfig("openai"),
          guestReasoningClaim("openai", "qwen3.5-4b-q4_k_m")
        ),
    },
    {
      name: "local rejects a non-local model",
      run: () =>
        invokeHandlers.get("process-local-reasoning")(
          { sender },
          "hello",
          "gpt-5-mini",
          null,
          reasoningConfig("qwen"),
          guestReasoningClaim("qwen", "gpt-5-mini")
        ),
    },
    {
      name: "Anthropic ignores a hostile local provider",
      run: () =>
        invokeHandlers.get("process-anthropic-reasoning")(
          { sender },
          "hello",
          "claude-sonnet-4-6",
          null,
          reasoningConfig("qwen"),
          guestReasoningClaim("qwen", "claude-sonnet-4-6")
        ),
    },
  ];

  for (const row of rows) {
    await t.test(row.name, async () => {
      dispatches.length = 0;
      fetches.length = 0;
      anthropicCredentialReads = 0;
      const result = await row.run();
      assert.equal(result.success, false);
      assert.equal(result.code, "AUTHORIZATION_BOUNDARY_CHANGED");
      assert.deepEqual(dispatches, []);
      assert.deepEqual(fetches, []);
      assert.equal(anthropicCredentialReads, 0);
    });
  }
});

test("managed local reasoning rechecks its exact artifact after admission", async (t) => {
  const sender = createSender();
  const model = "qwen3.5-4b-q4_k_m";
  const route = {
    provider: "qwen",
    model,
    inferenceScope: "chatIntelligence",
    setupMode: "auto",
  };
  const claim = reasoningClaim("qwen", model, true);
  const rows = [
    {
      name: "renderer preflight",
      run: () => invokeHandlers.get("authorize-reasoning-start")({ sender }, route, claim),
    },
    {
      name: "local one-shot",
      run: () =>
        invokeHandlers.get("process-local-reasoning")(
          { sender },
          "hello",
          model,
          null,
          route,
          claim
        ),
    },
  ];

  for (const [availability, behavior] of [
    ["deleted", false],
    ["status check failed", new Error("disk unavailable")],
  ]) {
    for (const row of rows) {
      await t.test(`${row.name}: ${availability}`, async () => {
        await activateManagedLocal();
        managedReasoningArtifactDownloaded = behavior;
        dispatches.length = 0;
        const result = await row.run();
        assert.equal(result.success, false);
        assert.equal(result.code, "MANAGED_LOCAL_MODEL_UNAVAILABLE");
        assert.deepEqual(dispatches, [`artifact:${model}`]);
      });
    }
  }
});

test("available managed local artifact is checked immediately before local dispatch", async () => {
  const sender = createSender();
  const model = "qwen3.5-4b-q4_k_m";
  await activateManagedLocal();
  dispatches.length = 0;
  const result = await invokeHandlers.get("process-local-reasoning")(
    { sender },
    "hello",
    model,
    null,
    reasoningConfig("hostile-renderer-value"),
    reasoningClaim("qwen", model, true)
  );
  assert.equal(result.success, true);
  assert.deepEqual(dispatches, [`artifact:${model}`, "local"]);
});

test("managed enterprise starts require exact admitted context before runtime resolution", async (t) => {
  const sender = createSender();
  const claim = reasoningClaim("bedrock", "managed-model", true);
  const rows = [
    ["missing context", undefined],
    ["wrong account", managedEnterpriseContext({ accountId: "account-b" })],
    ["wrong workspace", managedEnterpriseContext({ workspaceId: "workspace-b" })],
    ["wrong auth generation", managedEnterpriseContext({ authGeneration: 8 })],
    ["wrong config generation", managedEnterpriseContext({ generation: 12 })],
    ["wrong provider", managedEnterpriseContext({ provider: "azure" })],
    ["wrong scope", managedEnterpriseContext({ inferenceScope: "dictationCleanup" })],
    ["wrong setup mode", managedEnterpriseContext({ setupMode: "manual" })],
  ];

  for (const [name, managedContext] of rows) {
    const config = { ...reasoningConfig("bedrock"), managedContext };
    for (const [kind, run] of [
      [
        "one-shot",
        () =>
          invokeHandlers.get("process-enterprise-reasoning")(
            { sender },
            "hello",
            "managed-model",
            null,
            config,
            claim
          ),
      ],
      [
        "stream",
        () =>
          invokeHandlers.get("enterprise-stream-start")(
            { sender },
            {
              streamId: "managed-stream",
              provider: "bedrock",
              modelId: "managed-model",
              config,
              options: {},
            },
            claim
          ),
      ],
    ]) {
      await t.test(`${kind}: ${name}`, async () => {
        await activateManagedCloud();
        enterpriseProviderCalls = 0;
        dispatches.length = 0;
        sender.sent.length = 0;
        const result = await run(managedContext);
        assert.equal(result.success, false);
        assert.equal(result.code, "MANAGED_CONFIG_CHANGED");
        assert.equal(enterpriseProviderCalls, 0);
        assert.deepEqual(dispatches, []);
      });
    }
  }
});

test("managed enterprise runtime must match the admitted route and provider version", async (t) => {
  const sender = createSender();
  const claim = reasoningClaim("bedrock", "managed-model", true);
  const rows = [
    ["wrong resolved model", { model: "other-model" }],
    ["wrong resolved provider", { provider: "azure" }],
    ["wrong resolved generation", { generation: 12 }],
    ["wrong resolved provider version", { version: 4 }],
  ];

  const config = {
    ...reasoningConfig("bedrock"),
    managedContext: managedEnterpriseContext(),
  };

  for (const [name, mutation] of rows) {
    for (const [kind, run] of [
      [
        "one-shot",
        () =>
          invokeHandlers.get("process-enterprise-reasoning")(
            { sender },
            "hello",
            "managed-model",
            null,
            config,
            claim
          ),
      ],
      [
        "stream",
        () =>
          invokeHandlers.get("enterprise-stream-start")(
            { sender },
            {
              streamId: "managed-runtime-stream",
              provider: "bedrock",
              modelId: "managed-model",
              config,
              options: {},
            },
            claim
          ),
      ],
    ]) {
      await t.test(`${kind}: ${name}`, async () => {
        await activateManagedCloud();
        const baseBehavior = enterpriseProviderBehavior;
        enterpriseProviderBehavior = async (requestInput) => ({
          ...(await baseBehavior(requestInput)),
          ...mutation,
        });
        enterpriseProviderCalls = 0;
        dispatches.length = 0;
        const result = await run();
        assert.equal(result.success, false);
        assert.equal(result.code, "MANAGED_CONFIG_CHANGED");
        assert.equal(enterpriseProviderCalls, 1);
        assert.deepEqual(dispatches, []);
      });
    }
  }
});

test("managed enterprise one-shot and stream dispatch only the admitted runtime", async (t) => {
  const sender = createSender();
  const claim = reasoningClaim("bedrock", "managed-model", true);
  const config = {
    ...reasoningConfig("bedrock"),
    managedContext: managedEnterpriseContext(),
  };
  const expectedDispatches = {
    "one-shot": ["enterprise-model", "enterprise-generate"],
    stream: ["enterprise-model"],
  };

  for (const [name, run] of [
    [
      "one-shot",
      () =>
        invokeHandlers.get("process-enterprise-reasoning")(
          { sender },
          "hello",
          "managed-model",
          null,
          config,
          claim
        ),
    ],
    [
      "stream",
      () =>
        invokeHandlers.get("enterprise-stream-start")(
          { sender },
          {
            streamId: "managed-success-stream",
            provider: "bedrock",
            modelId: "managed-model",
            config,
            options: {},
          },
          claim
        ),
    ],
  ]) {
    await t.test(name, async () => {
      await activateManagedCloud();
      enterpriseProviderCalls = 0;
      dispatches.length = 0;
      const result = await run();
      assert.equal(result.success, true);
      assert.equal(enterpriseProviderCalls, 1);
      assert.deepEqual(dispatches, expectedDispatches[name]);
    });
  }
});

test("unmanaged enterprise reasoning keeps the manual runtime without resolving managed credentials", async () => {
  const sender = createSender();
  const result = await invokeHandlers.get("process-enterprise-reasoning")(
    { sender },
    "hello",
    "manual-deployment",
    null,
    {
      ...reasoningConfig("azure"),
      apiKey: "manual-key",
      azureEndpoint: "https://example.openai.azure.com",
      azureApiVersion: "v1",
      managedContext: managedEnterpriseContext(),
    },
    guestReasoningClaim("azure", "manual-deployment")
  );
  assert.equal(result.success, true);
  assert.equal(enterpriseProviderCalls, 0);
  assert.deepEqual(dispatches, ["enterprise-model", "enterprise-generate"]);
});

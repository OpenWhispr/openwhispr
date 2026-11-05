const { withDevicePolicy } = require("./harness/devicePolicy");
const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const http = require("node:http");
const { deferred } = require("./harness/deferred");

const handlersModulePath = require.resolve("../../src/helpers/ipcHandlers");
const originalLoad = Module._load;
const handlers = new Map();
const listeners = new Map();
const generateCalls = [];
let generateBehavior = async () => ({ text: "hello", finishReason: "stop" });
let resolveManagedRuntime = async () => ({ managed: false });
let handlerContext;

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
    on: (channel, fn) => listeners.set(channel, fn),
    removeHandler: () => {},
  },
  net: {
    fetch: async () => ({
      ok: true,
      status: 200,
      json: async () => ({}),
      text: async () => "{}",
    }),
  },
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
  if (request === "./tokenStore")
    return { get: () => null, getState: () => ({ token: null, generation: 0 }) };
  if (request === "./enterpriseIdentityManager") {
    return {
      createEnterpriseIdentityManager: () => ({
        resolveProvider: (...args) => resolveManagedRuntime(...args),
        clear: () => {},
      }),
    };
  }
  if (parent?.filename === handlersModulePath) {
    if (request === "./debugLogger") {
      return new Proxy({}, { get: () => () => {} });
    }
    if (request === "ai") {
      return {
        generateText: async (options) => {
          generateCalls.push(options);
          return generateBehavior(options);
        },
      };
    }
    if (request === "./enterpriseAiProviders") {
      return {
        getEnterpriseAIModel: async (_provider, _model, _apiKey, enterprise) => {
          await enterprise?.managedCredentialProvider?.();
          return { provider: "bedrock-test-model" };
        },
      };
    }
    if (request === "./cortiTranscription") {
      return { transcribeAudio: async () => ({ text: "corti text" }) };
    }
    if (request === "./tinfoilTranscription") {
      return {
        transcribeWithTinfoil: async () => ({ text: "tinfoil text", model: "tinfoil-model" }),
        getTinfoilChatModels: () => [],
      };
    }
    if (request === "./windowBroadcast") {
      return { broadcastToWindows: () => {} };
    }
  }
  return originalLoad.call(this, request, parent, isMain);
};

function anything() {
  return new Proxy(function () {}, {
    get: (target, property) => {
      if (property === Symbol.toPrimitive || property === "toString") return () => "";
      if (property === "then") return undefined;
      return anything();
    },
    apply: () => anything(),
  });
}

function buildFakeThis() {
  const AgentStreamRequestRegistry = require("../../src/helpers/agentStreamRequestRegistry");
  const target = {
    sessionId: "test-session",
    _enterpriseReasoningRequests: new AgentStreamRequestRegistry(),
  };
  return new Proxy(target, {
    get: (value, property) => (property in value ? value[property] : anything()),
  });
}

function sender(id) {
  const eventListeners = new Map();
  let destroyed = false;
  return {
    id,
    once: (event, listener) => eventListeners.set(event, listener),
    removeListener: (event, listener) => {
      if (eventListeners.get(event) === listener) eventListeners.delete(event);
    },
    isDestroyed: () => destroyed,
    destroy: () => {
      destroyed = true;
      eventListeners.get("destroyed")?.();
    },
  };
}

function retryable503() {
  return Object.assign(new Error("Bedrock overloaded"), {
    name: "ServiceUnavailableException",
    statusCode: 503,
    responseHeaders: { "x-amzn-requestid": "aws-request-503" },
  });
}

function managedContext() {
  return {
    accountId: "account-1",
    workspaceId: "workspace-1",
    authGeneration: 1,
    inferenceScope: "cleanup",
    setupMode: "managed",
    provider: "bedrock",
    generation: 1,
    providerVersion: 1,
  };
}

function managedBedrockRuntime(overrides = {}) {
  return {
    managed: true,
    provider: "bedrock",
    model: "anthropic.claude-haiku",
    generation: 1,
    version: 1,
    config: { region: "us-west-2" },
    credentialProvider: async () => ({
      accessKeyId: "AKIAEXAMPLE",
      secretAccessKey: "example-secret",
      sessionToken: "example-session-token",
    }),
    ...overrides,
  };
}

test.before(() => {
  delete require.cache[handlersModulePath];
  const IPCHandlers = require(handlersModulePath);
  const Ctor = IPCHandlers.default || IPCHandlers;
  handlerContext = buildFakeThis();
  Ctor.prototype.setupHandlers.call(withDevicePolicy(handlerContext));
  assert.ok(handlers.get("test-enterprise-connection"));
  assert.ok(handlers.get("process-enterprise-reasoning"));
  assert.ok(listeners.get("enterprise-reasoning-cancel"));
});

test.after(() => {
  Module._load = originalLoad;
});

test.beforeEach(() => {
  generateCalls.length = 0;
  resolveManagedRuntime = async () => ({ managed: false });
});

for (const stage of ["runtime", "foundation request", "pagination", "normal success"]) {
  test(`Bedrock catalog handles ${stage} with the real SDK`, { timeout: 5000 }, async (t) => {
    const { normalizeDeviceValues } = require("../../src/helpers/managedDevicePolicy");
    const IPCHandlers = require(handlersModulePath);
    const read = handlerContext.managedDevicePolicy.getSnapshot;
    const stop = handlerContext._stopRemoteProductWork;
    const endpoint = process.env.AWS_ENDPOINT_URL_BEDROCK;
    const entered = deferred(),
      finish = deferred(),
      closed = deferred();
    const requests = [];
    let held;
    const payload = {
      modelSummaries: [
        {
          modelId: "test-model",
          outputModalities: ["TEXT"],
          inferenceTypesSupported: ["ON_DEMAND"],
        },
      ],
      inferenceProfileSummaries: [],
    };
    const server = http.createServer((request, response) => {
      requests.push(request.url);
      response.setHeader("Content-Type", "application/json");
      if (
        (stage === "foundation request" && request.url.startsWith("/foundation-models")) ||
        (stage === "pagination" && request.url.includes("nextToken="))
      ) {
        held = response;
        response.once("close", () => closed.resolve(response.writableFinished));
        entered.resolve();
      } else
        response.end(
          JSON.stringify(
            stage === "pagination" && request.url.startsWith("/inference-profiles")
              ? { ...payload, nextToken: "next-page" }
              : payload
          )
        );
    });
    t.after(() => {
      finish.resolve();
      server.closeAllConnections();
      server.close();
      handlerContext.managedDevicePolicy.getSnapshot = read;
      handlerContext._stopRemoteProductWork = stop;
      handlerContext.effectivePolicyManager.getCurrent();
      if (endpoint === undefined) delete process.env.AWS_ENDPOINT_URL_BEDROCK;
      else process.env.AWS_ENDPOINT_URL_BEDROCK = endpoint;
    });
    server.listen(0, "127.0.0.1");
    await new Promise((resolve) => server.once("listening", resolve));
    process.env.AWS_ENDPOINT_URL_BEDROCK = `http://127.0.0.1:${server.address().port}`;
    handlerContext._stopRemoteProductWork =
      IPCHandlers.prototype._stopRemoteProductWork.bind(handlerContext);
    resolveManagedRuntime = async () => {
      if (stage === "runtime") {
        entered.resolve();
        await finish.promise;
      }
      return managedBedrockRuntime();
    };
    const pending = handlers.get("bedrock-list-models")(
      { sender: sender(99) },
      { managedContext: managedContext() }
    );
    if (stage === "normal success") {
      assert.deepEqual(await pending, {
        success: true,
        models: [{ value: "test-model", label: "test-model", vendor: "" }],
      });
      assert.equal(requests.length, 2);
      return;
    }
    await entered.promise;
    handlerContext.managedDevicePolicy.getSnapshot = () =>
      normalizeDeviceValues({ RequireSignIn: false });
    handlerContext.effectivePolicyManager.getCurrent();
    finish.resolve();
    const fallback = held && setTimeout(() => held.end(JSON.stringify(payload)), 300);
    t.after(() => clearTimeout(fallback));
    assert.equal((await pending).code, "DEVICE_POLICY_BLOCKED");
    if (stage === "runtime") assert.equal(requests.length, 0);
    else
      assert.equal(
        await closed.promise,
        false,
        "policy cancellation closes the active HTTP response"
      );
  });
}

for (const [provider, stage] of [
  ["bedrock", "runtime"],
  ["azure", "runtime"],
  ["bedrock", "credentials"],
  ["bedrock", "generation"],
  ["azure", "generation"],
]) {
  test(`enterprise probe policy revocation during ${provider} ${stage} prevents transmission and retries`, async (t) => {
    const started = deferred();
    const finish = deferred();
    const manager = handlerContext.effectivePolicyManager;
    const refresh = handlerContext.refreshEffectivePolicy;
    const generate = generateBehavior;
    let snapshot = { success: true, managed: false };
    handlerContext.effectivePolicyManager = { getCurrent: () => snapshot };
    handlerContext.refreshEffectivePolicy = async () => snapshot;
    t.after(() => {
      finish.resolve();
      handlerContext.effectivePolicyManager = manager;
      handlerContext.refreshEffectivePolicy = refresh;
      generateBehavior = generate;
    });
    t.mock.method(Math, "random", () => 0);
    const runtime = managedBedrockRuntime({
      provider,
      ...(provider === "azure" ? { config: { endpoint: "https://example.openai.azure.com" } } : {}),
    });
    const credentials = runtime.credentialProvider;
    if (stage === "credentials") {
      runtime.credentialProvider = async () => {
        started.resolve();
        await finish.promise;
        return credentials();
      };
    }
    resolveManagedRuntime = async () => {
      if (stage === "runtime") {
        started.resolve();
        await finish.promise;
      }
      return runtime;
    };
    generateBehavior = async () => {
      started.resolve();
      await finish.promise;
      throw retryable503();
    };
    const pending = handlers.get("test-enterprise-connection")({ sender: sender(99) }, provider, {
      model: "test-model",
      managedContext: { ...managedContext(), provider },
    });
    await started.promise;
    const policy = require("../../src/helpers/managedDevicePolicy").defaultDevicePolicy();
    policy.llm.allowedModes = ["local"];
    snapshot = { success: true, managed: true, policy, localOnly: true };
    require(handlersModulePath).prototype._stopRemoteProductWork.call(handlerContext);
    finish.resolve();
    assert.equal((await pending).code, "DEVICE_POLICY_BLOCKED");
    assert.equal(generateCalls.length, stage === "generation" ? 1 : 0);
    if (stage === "generation") assert.equal(generateCalls[0].abortSignal?.aborted, true);
  });
}

test("Check connection asks for at least 16 output tokens, the Azure Responses API minimum", async () => {
  // Live 2026-09-07: Azure rejected the probe with "Invalid 'max_output_tokens':
  // integer below minimum value. Expected a value >= 16, but got 10 instead."
  const probes = [
    ["bedrock", { model: "anthropic.claude-haiku", bedrockRegion: "eu-west-1" }],
    ["azure", { model: "gpt-4.1-mini", azureEndpoint: "https://acme.openai.azure.com" }],
  ];
  for (const [provider, config] of probes) {
    const result = await handlers.get("test-enterprise-connection")(
      { sender: sender(3) },
      provider,
      config
    );
    assert.deepEqual(result, { success: true }, provider);
  }
  assert.equal(generateCalls.length, probes.length);
  for (const call of generateCalls) {
    assert.ok(
      call.maxOutputTokens >= 16,
      `maxOutputTokens ${call.maxOutputTokens} is below Azure's minimum of 16`
    );
  }
});

test("Check connection uses the Bedrock retry policy and disables nested AI SDK retries", async () => {
  let attempts = 0;
  generateBehavior = async () => {
    attempts += 1;
    if (attempts === 1) throw retryable503();
    return { text: "hello", finishReason: "stop" };
  };
  const originalRandom = Math.random;
  Math.random = () => 0;
  try {
    const result = await handlers.get("test-enterprise-connection")(
      { sender: sender(2) },
      "bedrock",
      {
        model: "anthropic.claude-haiku",
        bedrockRegion: "eu-west-1",
      }
    );

    assert.deepEqual(result, { success: true });
    assert.equal(generateCalls.length, 2);
    assert.ok(generateCalls.every((call) => call.maxRetries === 0));
  } finally {
    Math.random = originalRandom;
  }
});

test("Check connection retries timed-out Bedrock attempts with the existing timeout message", async () => {
  let attempts = 0;
  generateBehavior = async (options) => {
    attempts += 1;
    await new Promise((resolve, reject) => {
      options.abortSignal.addEventListener("abort", () => reject(options.abortSignal.reason), {
        once: true,
      });
    });
  };
  const originalRandom = Math.random;
  Math.random = () => 0;
  let watchdog;
  try {
    const request = handlers.get("test-enterprise-connection")({ sender: sender(1) }, "bedrock", {
      model: "anthropic.claude-haiku",
      bedrockRegion: "eu-west-1",
      timeoutMs: 5,
    });
    const result = await Promise.race([
      request,
      new Promise((_, reject) => {
        watchdog = setTimeout(() => reject(new Error("Bedrock timeout did not settle")), 250);
      }),
    ]);

    assert.equal(attempts, 6);
    assert.equal(
      result.error,
      "AWS Bedrock did not respond in time. Please try again. If this continues, check your internet connection and AWS Bedrock service status."
    );
  } finally {
    clearTimeout(watchdog);
    Math.random = originalRandom;
  }
});

test("Check connection timeout includes managed credential resolution", async () => {
  let releaseCredentials;
  let credentialAttempts = 0;
  const resolvingCredentials = new Promise((resolve) => (releaseCredentials = resolve));
  resolveManagedRuntime = async () =>
    managedBedrockRuntime({
      credentialProvider: async () => {
        credentialAttempts += 1;
        return resolvingCredentials;
      },
    });
  handlerContext.enterpriseIdentityManager = {
    resolveProvider: (...args) => resolveManagedRuntime(...args),
    clear: () => {},
  };
  generateBehavior = async () => ({ text: "hello", finishReason: "stop" });
  const originalRandom = Math.random;
  Math.random = () => 0;
  try {
    const request = handlers.get("test-enterprise-connection")({ sender: sender(22) }, "bedrock", {
      model: "renderer-model-is-ignored",
      managedContext: managedContext(),
      timeoutMs: 5,
    });
    const completedInBound = await Promise.race([
      request.then((result) => ({ completed: true, result })),
      new Promise((resolve) => setTimeout(() => resolve({ completed: false }), 250)),
    ]);
    releaseCredentials({
      accessKeyId: "AKIAEXAMPLE",
      secretAccessKey: "example-secret",
      sessionToken: "example-session-token",
    });
    const result = await request;

    assert.equal(completedInBound.completed, true);
    assert.equal(credentialAttempts, 6);
    assert.equal(
      result.error,
      "AWS Bedrock did not respond in time. Please try again. If this continues, check your internet connection and AWS Bedrock service status."
    );
  } finally {
    Math.random = originalRandom;
  }
});

test("dictation cleanup uses the Bedrock retry policy and returns the eventual text", async () => {
  let attempts = 0;
  generateBehavior = async () => {
    attempts += 1;
    if (attempts === 1) throw retryable503();
    return { text: "cleaned dictation", finishReason: "stop" };
  };
  const originalRandom = Math.random;
  Math.random = () => 0;
  try {
    const result = await handlers.get("process-enterprise-reasoning")(
      { sender: sender(3) },
      "raw dictation",
      "anthropic.claude-haiku",
      null,
      {
        provider: "bedrock",
        inferenceScope: "dictationCleanup",
        bedrockRegion: "eu-west-1",
        systemPrompt: "Clean the dictation",
      }
    );

    assert.deepEqual(result, { success: true, text: "cleaned dictation" });
    assert.equal(generateCalls.length, 2);
    assert.ok(generateCalls.every((call) => call.maxRetries === 0));
  } finally {
    Math.random = originalRandom;
  }
});

test("non-cleanup Bedrock scopes preserve the AI SDK retry policy", async () => {
  generateBehavior = async () => {
    throw retryable503();
  };
  const originalRandom = Math.random;
  Math.random = () => 0;
  try {
    const result = await handlers.get("process-enterprise-reasoning")(
      { sender: sender(6) },
      "translate this",
      "anthropic.claude-haiku",
      null,
      {
        provider: "bedrock",
        inferenceScope: "dictationTranslation",
        bedrockRegion: "eu-west-1",
        systemPrompt: "Translate it",
      }
    );

    assert.equal(result.success, false);
    assert.equal(generateCalls.length, 1);
    assert.equal("maxRetries" in generateCalls[0], false);
  } finally {
    Math.random = originalRandom;
  }
});

test("Bedrock cleanup cancellation aborts only the requesting renderer without retrying", async () => {
  const requestingSender = sender(10);
  const otherSender = sender(11);
  let attempts = 0;
  let requestSignal;
  let releaseRequest;
  const started = new Promise((resolve) => (releaseRequest = resolve));
  generateBehavior = async (options) => {
    attempts += 1;
    requestSignal = options.abortSignal;
    releaseRequest();
    await new Promise((resolve, reject) => {
      options.abortSignal.addEventListener("abort", () => reject(options.abortSignal.reason), {
        once: true,
      });
    });
  };

  const request = handlers.get("process-enterprise-reasoning")(
    { sender: requestingSender },
    "raw dictation",
    "anthropic.claude-haiku",
    null,
    {
      provider: "bedrock",
      inferenceScope: "dictationCleanup",
      bedrockRegion: "eu-west-1",
      systemPrompt: "Clean the dictation",
    }
  );
  await started;
  listeners.get("enterprise-reasoning-cancel")({ sender: otherSender });
  assert.equal(requestSignal.aborted, false);
  listeners.get("enterprise-reasoning-cancel")({ sender: requestingSender });
  await request;

  assert.equal(requestSignal.aborted, true);
  assert.equal(attempts, 1);
});

test("Bedrock cleanup cancellation settles while managed runtime resolution is pending", async () => {
  const requestingSender = sender(12);
  let releaseResolution;
  let resolutionStarted;
  const resolving = new Promise((resolve) => (releaseResolution = resolve));
  const started = new Promise((resolve) => (resolutionStarted = resolve));
  resolveManagedRuntime = async () => {
    resolutionStarted();
    return resolving;
  };
  handlerContext.enterpriseIdentityManager = {
    resolveProvider: (...args) => resolveManagedRuntime(...args),
    clear: () => {},
  };

  const request = handlers.get("process-enterprise-reasoning")(
    { sender: requestingSender },
    "raw dictation",
    "anthropic.claude-haiku",
    null,
    {
      provider: "bedrock",
      inferenceScope: "dictationCleanup",
      managedContext: {
        accountId: "account-1",
        workspaceId: "workspace-1",
        authGeneration: 1,
        inferenceScope: "cleanup",
        setupMode: "managed",
        provider: "bedrock",
        generation: 1,
        providerVersion: 1,
      },
    }
  );
  await Promise.race([
    started,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("managed resolution did not start")), 100)
    ),
  ]);
  listeners.get("enterprise-reasoning-cancel")({ sender: requestingSender });
  const settledBeforeRelease = await Promise.race([
    request.then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), 25)),
  ]);
  releaseResolution({
    managed: true,
    provider: "bedrock",
    model: "anthropic.claude-haiku",
    generation: 1,
    version: 1,
    config: { region: "eu-west-1" },
    credentialProvider: async () => ({}),
  });
  await request;

  assert.equal(settledBeforeRelease, true);
  assert.equal(generateCalls.length, 0);
});

test("Bedrock cleanup cancellation settles while managed credentials are pending", async () => {
  const requestingSender = sender(13);
  let releaseCredentials;
  let credentialsStarted;
  const resolvingCredentials = new Promise((resolve) => (releaseCredentials = resolve));
  const started = new Promise((resolve) => (credentialsStarted = resolve));
  resolveManagedRuntime = async () =>
    managedBedrockRuntime({
      credentialProvider: async () => {
        credentialsStarted();
        return resolvingCredentials;
      },
    });
  handlerContext.enterpriseIdentityManager = {
    resolveProvider: (...args) => resolveManagedRuntime(...args),
    clear: () => {},
  };

  const request = handlers.get("process-enterprise-reasoning")(
    { sender: requestingSender },
    "raw dictation",
    "anthropic.claude-haiku",
    null,
    {
      provider: "bedrock",
      inferenceScope: "dictationCleanup",
      managedContext: managedContext(),
    }
  );
  await Promise.race([
    started,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("credentials did not start")), 100)
    ),
  ]);
  listeners.get("enterprise-reasoning-cancel")({ sender: requestingSender });
  const settledBeforeRelease = await Promise.race([
    request.then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), 25)),
  ]);
  releaseCredentials({
    accessKeyId: "AKIAEXAMPLE",
    secretAccessKey: "example-secret",
    sessionToken: "example-session-token",
  });
  await request;

  assert.equal(settledBeforeRelease, true);
  assert.equal(generateCalls.length, 0);
});

test("managed Bedrock failures use the resolved region in actionable copy", async () => {
  resolveManagedRuntime = async () => managedBedrockRuntime();
  handlerContext.enterpriseIdentityManager = {
    resolveProvider: (...args) => resolveManagedRuntime(...args),
    clear: () => {},
  };

  for (const { label, error, rendererRegion } of [
    {
      label: "permission",
      error: Object.assign(new Error("Not allowed to invoke model"), {
        name: "AccessDeniedException",
        $metadata: { httpStatusCode: 403, requestId: "managed-permission-request" },
      }),
      rendererRegion: "eu-west-1",
    },
    {
      label: "model",
      error: Object.assign(new Error("Selected model does not exist"), {
        name: "ResourceNotFoundException",
        $metadata: { httpStatusCode: 404, requestId: "managed-model-request" },
      }),
    },
    {
      label: "configuration",
      error: Object.assign(new Error("Invalid inference profile"), {
        name: "ValidationException",
        $metadata: { httpStatusCode: 400, requestId: "managed-config-request" },
      }),
      rendererRegion: "ap-southeast-1",
    },
  ]) {
    generateBehavior = async () => {
      throw error;
    };
    const result = await handlers.get("test-enterprise-connection")(
      { sender: sender(20) },
      "bedrock",
      {
        model: "renderer-model-is-ignored",
        managedContext: managedContext(),
        ...(rendererRegion ? { bedrockRegion: rendererRegion } : {}),
      }
    );

    assert.equal(result.success, false, label);
    assert.match(result.error, /us-west-2/, label);
    if (rendererRegion) assert.doesNotMatch(result.error, new RegExp(rendererRegion), label);
  }
});

test("managed Bedrock credential expiry keeps AWS diagnostics and gives no profile command", async () => {
  const expired = Object.assign(
    new Error("The security token included in the request is expired"),
    {
      name: "ExpiredTokenException",
      $metadata: {
        httpStatusCode: 403,
        requestId: "managed-expired-request",
      },
    }
  );
  resolveManagedRuntime = async () =>
    managedBedrockRuntime({
      credentialProvider: async () => {
        throw expired;
      },
    });
  handlerContext.enterpriseIdentityManager = {
    resolveProvider: (...args) => resolveManagedRuntime(...args),
    clear: () => {},
  };

  const result = await handlers.get("test-enterprise-connection")(
    { sender: sender(21) },
    "bedrock",
    { model: "renderer-model-is-ignored", managedContext: managedContext() }
  );

  assert.equal(result.success, false);
  assert.match(result.action, /sign out and sign back in/i);
  assert.equal(result.copyCommand, undefined);
  assert.deepEqual(result.technicalDetails, {
    status: 403,
    exceptionType: "ExpiredTokenException",
    requestId: "managed-expired-request",
    underlyingError: "The security token included in the request is expired",
  });
});

test("Check connection returns AWS diagnostics without a dictation fallback status", async () => {
  generateBehavior = async () => {
    throw Object.assign(new Error("Bad signature"), {
      name: "UnrecognizedClientException",
      statusCode: 401,
      responseHeaders: { "x-amzn-requestid": "connection-request-id" },
    });
  };

  const result = await handlers.get("test-enterprise-connection")(
    { sender: sender(4) },
    "bedrock",
    {
      model: "anthropic.claude-haiku",
      bedrockRegion: "eu-west-1",
    }
  );

  assert.equal(result.success, false);
  assert.match(result.error, /credentials were rejected/i);
  assert.deepEqual(result.technicalDetails, {
    status: 401,
    exceptionType: "UnrecognizedClientException",
    requestId: "connection-request-id",
    underlyingError: "Bad signature",
  });
  assert.equal("fallbackStatus" in result, false);
});

test("dictation cleanup returns preserved AWS diagnostics to the renderer", async () => {
  generateBehavior = async () => {
    throw Object.assign(new Error("Not allowed to invoke model"), {
      name: "AccessDeniedException",
      statusCode: 403,
      responseHeaders: { "x-amzn-requestid": "cleanup-request-id" },
    });
  };

  const result = await handlers.get("process-enterprise-reasoning")(
    { sender: sender(5) },
    "raw dictation",
    "anthropic.claude-haiku",
    null,
    {
      provider: "bedrock",
      inferenceScope: "dictationCleanup",
      bedrockRegion: "eu-west-1",
      systemPrompt: "Clean it",
    }
  );

  assert.equal(result.success, false);
  assert.match(result.error, /denied this request/i);
  assert.deepEqual(result.technicalDetails, {
    status: 403,
    exceptionType: "AccessDeniedException",
    requestId: "cleanup-request-id",
    underlyingError: "Not allowed to invoke model",
  });
});

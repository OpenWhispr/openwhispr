const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

const handlersModulePath = require.resolve("../../src/helpers/ipcHandlers");
const originalLoad = Module._load;
const handlers = new Map();
const listeners = new Map();
const generateCalls = [];
let generateBehavior = async () => ({ text: "hello", finishReason: "stop" });
let resolveManagedRuntime = async () => ({ managed: false });
let handlerContext;
let streamBehavior;
const streamLogs = [];

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
  if (request === "./tokenStore") return { get: () => "test-token" };
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
      return new Proxy(
        {},
        {
          get:
            () =>
            (...args) =>
              streamLogs.push(args),
        }
      );
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
          return { provider: "bedrock-test-model", doStream: (options) => streamBehavior(options) };
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
  Ctor.prototype.setupHandlers.call(handlerContext);
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

async function chatProxy(t, behavior) {
  const { EventEmitter } = require("node:events");
  const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");
  const webContents = new EventEmitter();
  Object.assign(webContents, { id: 500, isDestroyed: () => false });
  const messages = [];
  let listener;
  let completion;
  let cancelled = 0;
  streamBehavior = behavior;
  streamLogs.length = 0;
  webContents.send = (_channel, payload) => {
    const cloned = structuredClone(payload);
    messages.push(cloned);
    listener?.(cloned);
  };
  installBrowserGlobals(t, {
    window: {
      electronAPI: {
        onEnterpriseStreamPart: (callback) => {
          listener = callback;
          return () => {
            listener = undefined;
          };
        },
        enterpriseStreamStart: (payload) => {
          completion = handlers.get("enterprise-stream-start")({ sender: webContents }, payload);
          return completion;
        },
        enterpriseStreamCancel: (streamId) => {
          cancelled += 1;
          return handlers.get("enterprise-stream-cancel")({ sender: webContents }, streamId);
        },
      },
    },
  });
  const vite = await createRendererServer(t, {
    mockModules: {
      "/enterpriseSettings": `export const getEnterpriseCallSettings = () => ({});`,
    },
  });
  const { createEnterpriseChatModel } = await vite.ssrLoadModule(
    "/services/ai/enterpriseChatModel.ts"
  );
  return {
    model: createEnterpriseChatModel("azure", "test-deployment"),
    messages,
    completion: () => completion,
    cancelled: () => cancelled,
    assertClean() {
      assert.equal(listener, undefined);
      assert.equal(handlerContext.enterpriseStreamAborts.size, 0);
      assert.equal(webContents.listenerCount("destroyed"), 0);
      assert.equal(webContents.listenerCount("did-start-navigation"), 0);
    },
  };
}

for (const failureMode of ["event", "throw"]) {
  test(`enterprise Chat safely maps ${failureMode} errors across the actual IPC relay and renderer proxy`, async (t) => {
    let cancelled = false;
    const failure = {
      type: "error",
      sequence_number: 1,
      error: {
        code: "rate_limit_exceeded",
        message: "TooManyRequests private-prompt Bearer fixture-token",
        status: 429,
      },
      request_id: "request-123",
      responseHeaders: { authorization: "Bearer fixture-secret" },
      responseBody: "private-prompt",
    };
    const proxy = await chatProxy(t, async () => {
      if (failureMode === "throw") throw failure;
      return {
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({ type: "error", error: failure });
          },
          cancel() {
            cancelled = true;
          },
        }),
      };
    });
    const { stream } = await proxy.model.doStream({ prompt: [] });
    await assert.rejects(
      async () => {
        for await (const part of stream)
          assert.notEqual(part.type, "error", "raw provider errors must not cross IPC");
      },
      (error) => {
        assert.ok(error instanceof Error);
        assert.equal(error.messageKey, "providerErrors.rateLimited");
        assert.equal(error.technicalDetails.status, 429);
        assert.equal(error.technicalDetails.exceptionType, "rate_limit_exceeded");
        assert.equal(error.technicalDetails.requestId, "request-123");
        assert.doesNotMatch(error.message, /object Object/);
        return true;
      }
    );
    assert.equal((await proxy.completion()).success, false);
    const serialized = JSON.stringify([proxy.messages, streamLogs]);
    assert.doesNotMatch(
      serialized,
      /private-prompt|fixture-token|fixture-secret|responseBody|authorization/
    );
    if (failureMode === "event") assert.equal(cancelled, true);
    proxy.assertClean();
  });
}

test("enterprise Chat relays normal text and tool parts unchanged and removes abort listeners", async (t) => {
  const parts = [
    { type: "text-start", id: "text-1" },
    { type: "text-delta", id: "text-1", delta: "hello" },
    { type: "tool-call", toolCallId: "call-1", toolName: "lookup", input: "{}" },
    { type: "text-end", id: "text-1" },
  ];
  const proxy = await chatProxy(t, async () => ({
    stream: new ReadableStream({
      start(controller) {
        for (const part of parts) controller.enqueue(part);
        controller.close();
      },
    }),
  }));
  const abort = new AbortController();
  const { stream } = await proxy.model.doStream({ prompt: [], abortSignal: abort.signal });
  assert.deepEqual(await Array.fromAsync(stream), parts);
  assert.equal((await proxy.completion()).success, true);
  abort.abort();
  assert.equal(proxy.cancelled(), 0);
  proxy.assertClean();
});

test("enterprise Chat abort terminates the relay without a provider failure log", async (t) => {
  const proxy = await chatProxy(t, async ({ abortSignal }) => ({
    stream: new ReadableStream({
      start(controller) {
        abortSignal.addEventListener("abort", () => controller.error(abortSignal.reason), {
          once: true,
        });
      },
    }),
  }));
  const abort = new AbortController();
  const { stream } = await proxy.model.doStream({ prompt: [], abortSignal: abort.signal });
  const reading = Array.fromAsync(stream);
  await new Promise((resolve) => setImmediate(resolve));
  abort.abort();
  await assert.rejects(reading, { name: "AbortError" });
  await proxy.completion();
  assert.equal(
    streamLogs.some(([message]) => message === "Enterprise stream error:"),
    false
  );
  proxy.assertClean();
});

test("enterprise Chat emits an Error with safe metadata through streamText", async (t) => {
  const { streamText } = await import("ai");
  const proxy = await chatProxy(t, async () => ({
    stream: new ReadableStream({
      start(controller) {
        controller.enqueue({
          type: "error",
          error: {
            type: "error",
            sequence_number: 1,
            error: {
              code: "invalid_request_error",
              message: "private-prompt",
              param: "private-prompt",
            },
          },
        });
        controller.close();
      },
    }),
  }));
  const errors = [];
  const result = streamText({
    model: proxy.model,
    prompt: "unused mock input",
    onError: ({ error }) => errors.push(error),
  });
  await assert.rejects(
    async () => {
      for await (const part of result.fullStream) {
        if (part.type === "error") throw part.error;
      }
    },
    (error) => {
      assert.ok(error instanceof Error);
      if (errors.length) assert.equal(error, errors[0]);
      assert.equal(error.technicalDetails.exceptionType, "invalid_request_error");
      assert.equal(error.messageKey, "providerErrors.badRequest");
      assert.doesNotMatch(error.message, /object Object|private-prompt/);
      return true;
    }
  );
  await proxy.completion();
  proxy.assertClean();
});

test("enterprise stream normalization handles malformed and nested causes without serializing them", () => {
  const { mapEnterpriseStreamError } = require("../../src/helpers/enterpriseProviderErrors");
  const cyclic = { message: "private-prompt" };
  cyclic.cause = cyclic;
  for (const error of [
    null,
    undefined,
    3,
    {},
    "private-prompt",
    cyclic,
    { message: { secret: "private-prompt" } },
  ]) {
    const mapped = mapEnterpriseStreamError("azure", error);
    assert.equal(mapped.messageKey, "providerErrors.unknown");
    assert.doesNotMatch(JSON.stringify(mapped), /object Object|private-prompt|secret/);
  }
  const mapped = mapEnterpriseStreamError(
    "azure",
    Object.assign(new Error("private-prompt"), {
      statusCode: 400,
      responseHeaders: {
        "Apim-Request-Id": "azure-request-123",
        authorization: "Bearer fixture-secret",
      },
      code: "invalid_request_error",
      responseBody: { secret: "private-prompt" },
    })
  );
  assert.equal(mapped.messageKey, "providerErrors.badRequest");
  assert.deepEqual(mapped.technicalDetails, {
    provider: "Azure OpenAI",
    status: 400,
    exceptionType: "invalid_request_error",
    requestId: "azure-request-123",
  });
  assert.doesNotMatch(JSON.stringify(mapped), /private-prompt|fixture-secret/);
  const unsafeIdentifiers = mapEnterpriseStreamError("azure", {
    code: "sk-proj-fixturesecret",
    requestId: "x".repeat(129),
  });
  assert.deepEqual(unsafeIdentifiers.technicalDetails, { provider: "Azure OpenAI" });
  const bedrock = mapEnterpriseStreamError(
    "bedrock",
    Object.assign(new Error("private-prompt"), { statusCode: 503 })
  );
  assert.equal(bedrock.messageKey, "reasoning.enterprise.errors.bedrock.serviceUnavailable");
  assert.doesNotMatch(JSON.stringify(bedrock), /private-prompt/);
});

test("enterprise stream code-only errors retain classification without inventing HTTP status", () => {
  const { mapEnterpriseStreamError } = require("../../src/helpers/enterpriseProviderErrors");
  for (const [code, messageKey] of [
    ["DeploymentNotFound", "providerErrors.modelNotFoundNoModel"],
    ["rate_limit_exceeded", "providerErrors.rateLimited"],
    ["content_filter", "providerErrors.contentFiltered"],
    ["invalid_request_error", "providerErrors.badRequest"],
    ["constructor", "providerErrors.unknown"],
    ["AUTH_EXPIRED", "common.managedConfigUnavailable"],
    ["PROVIDER_NOT_ALLOWED", "common.managedPolicyConflict"],
  ]) {
    const mapped = mapEnterpriseStreamError("azure", {
      error: { code, message: "private-prompt" },
    });
    assert.equal(mapped.messageKey, messageKey, code);
    assert.equal(mapped.technicalDetails.exceptionType, code);
    assert.equal(mapped.technicalDetails.status, undefined);
    assert.doesNotMatch(JSON.stringify(mapped), /private-prompt/);
  }
});

test("enterprise stream preserves safe network and message-only provider classifications", () => {
  const { mapEnterpriseStreamError } = require("../../src/helpers/enterpriseProviderErrors");
  const fixtures = [
    ["azure", new TypeError("fetch failed private-prompt"), "providerErrors.unreachable"],
    [
      "azure",
      new Error("DeploymentNotFound private-prompt"),
      "providerErrors.modelNotFoundNoModel",
    ],
    [
      "azure",
      { error: { message: "TooManyRequests private-prompt" } },
      "providerErrors.rateLimited",
    ],
    ["azure", { message: "ContentFilter private-prompt" }, "providerErrors.contentFiltered"],
    ["azure", { code: "ENOTFOUND", message: "private-prompt" }, "providerErrors.unreachable"],
    ["azure", { code: "ETIMEDOUT", message: "private-prompt" }, "providerErrors.unreachable"],
    [
      "vertex",
      { code: "PERMISSION_DENIED", message: "private-prompt" },
      "providerErrors.accessDenied",
    ],
    [
      "vertex",
      { code: "RESOURCE_EXHAUSTED", message: "private-prompt" },
      "providerErrors.rateLimited",
    ],
    ["vertex", { message: "NOT_FOUND private-prompt" }, "providerErrors.modelNotFoundNoModel"],
    ["vertex", { message: "INVALID_ARGUMENT private-prompt" }, "providerErrors.badRequest"],
    ["vertex", { message: "UNAUTHENTICATED private-prompt" }, "providerErrors.authFailed"],
  ];
  for (const [provider, error, messageKey] of fixtures) {
    const mapped = mapEnterpriseStreamError(provider, error);
    assert.equal(mapped.messageKey, messageKey, `${provider}: ${error.code || error.message}`);
    assert.equal(mapped.technicalDetails.status, undefined);
    assert.doesNotMatch(JSON.stringify(mapped), /private-prompt|cause|responseBody/);
  }
});

test("enterprise Chat preserves specific content-filter guidance without echoing provider text", () => {
  const { mapEnterpriseStreamError } = require("../../src/helpers/enterpriseProviderErrors");
  for (const error of [
    { error: { code: "content_filter", message: "private-prompt" } },
    { code: "ContentFilter", message: "private-prompt", statusCode: 400 },
    { error: { message: "content safety filtering rejected private-prompt" } },
  ]) {
    const mapped = mapEnterpriseStreamError("azure", error);
    assert.equal(mapped.messageKey, "providerErrors.contentFiltered");
    assert.equal(mapped.code, "PROVIDER_CONTENT_FILTERED");
    assert.match(mapped.error, /filtered this request for content safety/);
    assert.equal(mapped.technicalDetails.status, error.statusCode);
    assert.doesNotMatch(JSON.stringify(mapped), /private-prompt/);
  }
});

test("Vertex request quota failures do not claim the account is out of credit", () => {
  const { mapEnterpriseStreamError } = require("../../src/helpers/enterpriseProviderErrors");
  for (const error of [
    { code: "RESOURCE_EXHAUSTED", message: "Requests per minute quota exceeded. Try again later." },
    { message: "Requests per minute quota exceeded. Try again later." },
  ]) {
    const mapped = mapEnterpriseStreamError("vertex", error);
    assert.equal(mapped.messageKey, "providerErrors.rateLimited");
    assert.equal(mapped.code, "PROVIDER_RATE_LIMITED");
    assert.equal(mapped.technicalDetails.status, undefined);
    assert.doesNotMatch(mapped.error, /credit|billing|Requests per minute/);
  }
  const explicitCredit = mapEnterpriseStreamError("vertex", { code: "insufficient_quota" });
  assert.equal(explicitCredit.messageKey, "providerErrors.quotaExhausted");
});

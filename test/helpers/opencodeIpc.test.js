const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

const handlersModulePath = require.resolve("../../src/helpers/ipcHandlers");
const factoryModulePath = require.resolve("../../src/helpers/opencodeLanguageModel");
const originalLoad = Module._load;
const handlers = new Map();
const generateCalls = [];
const openAiConfigs = [];
const anthropicConfigs = [];
const googleConfigs = [];
let generateBehavior = async () => ({ text: "hello", finishReason: "stop" });
let streamBehavior = null;
let keys = { go: "sk-go-test", zen: "sk-zen-test" };
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
    on: () => {},
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
  if (parent?.filename === handlersModulePath || parent?.filename === factoryModulePath) {
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
    if (request === "@ai-sdk/openai") {
      return {
        createOpenAI: (config) => {
          const seen = (constructor) => (modelId) => {
            openAiConfigs.push([constructor, config, modelId]);
            return {
              kind: constructor,
              modelId,
              doStream: async (options) => {
                if (streamBehavior) return streamBehavior({ modelId, options, kind: constructor });
                throw new Error("unexpected doStream");
              },
            };
          };
          return { chat: seen("chat"), responses: seen("responses") };
        },
      };
    }
    if (request === "@ai-sdk/anthropic") {
      return {
        createAnthropic: (config) => (modelId) => {
          anthropicConfigs.push(config);
          return {
            kind: "messages",
            modelId,
            doStream: async (options) => {
              if (streamBehavior) return streamBehavior({ modelId, options, kind: "messages" });
              throw new Error("unexpected doStream");
            },
          };
        },
      };
    }
    if (request === "@ai-sdk/google") {
      return {
        createGoogleGenerativeAI: (config) => (modelId) => {
          googleConfigs.push(config);
          return {
            kind: "generate-content",
            modelId,
            doStream: async (options) => {
              if (streamBehavior)
                return streamBehavior({ modelId, options, kind: "generate-content" });
              throw new Error("unexpected doStream");
            },
          };
        },
      };
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
  const target = {
    sessionId: "test-session",
    environmentManager: {
      getOpencodeGoKey: () => keys.go,
      getOpencodeZenKey: () => keys.zen,
    },
  };
  return new Proxy(target, {
    get: (value, property) => (property in value ? value[property] : anything()),
  });
}

function sender(id) {
  const eventListeners = new Map();
  const sent = [];
  let destroyed = false;
  return {
    id,
    sent,
    once: (event, listener) => eventListeners.set(event, listener),
    on: (event, listener) => eventListeners.set(event, listener),
    removeListener: (event, listener) => {
      if (eventListeners.get(event) === listener) eventListeners.delete(event);
    },
    isDestroyed: () => destroyed,
    destroy: () => {
      destroyed = true;
      eventListeners.get("destroyed")?.();
    },
    send: (channel, payload) => sent.push({ channel, payload }),
  };
}

function streamOf(parts) {
  return new ReadableStream({
    start(controller) {
      for (const part of parts) controller.enqueue(part);
      controller.close();
    },
  });
}

test.before(() => {
  delete require.cache[handlersModulePath];
  const IPCHandlers = require(handlersModulePath);
  const Ctor = IPCHandlers.default || IPCHandlers;
  handlerContext = buildFakeThis();
  Ctor.prototype.setupHandlers.call(handlerContext);
  assert.ok(handlers.get("process-opencode-reasoning"));
  assert.ok(handlers.get("opencode-stream-start"));
  assert.ok(handlers.get("opencode-stream-cancel"));
  assert.ok(handlers.get("get-opencode-models"));
});

test.after(() => {
  Module._load = originalLoad;
});

test("the live model list is requested with the configured key", async () => {
  const seen = [];
  const original = electronStub.net.fetch;
  electronStub.net.fetch = async (url, init) => {
    seen.push({ url, headers: init.headers });
    return {
      ok: true,
      status: 200,
      json: async () => ({
        data: [
          {
            id: "glm-5.3",
            name: "GLM-5.3",
            type: "chat",
            api: { "chat-completions": {} },
            capabilities: { temperature: true },
            cost: { text: { input: { price: 1 }, output: { price: 1 } } },
          },
        ],
      }),
    };
  };
  try {
    const models = await handlers.get("get-opencode-models")({}, "opencode-go");
    assert.deepEqual(
      models.map((model) => model.id),
      ["glm-5.3"]
    );
    assert.equal(seen[0].url, "https://opencode.ai/zen/go/v1/models");
    assert.deepEqual(seen[0].headers, { Authorization: "Bearer sk-go-test" });
  } finally {
    electronStub.net.fetch = original;
  }
});

test("the live model list refuses an unknown product before any request", async () => {
  await assert.rejects(
    handlers.get("get-opencode-models")({}, "opencode"),
    /Unsupported OpenCode provider/
  );
});

test.beforeEach(() => {
  generateCalls.length = 0;
  openAiConfigs.length = 0;
  anthropicConfigs.length = 0;
  googleConfigs.length = 0;
  generateBehavior = async () => ({ text: "hello", finishReason: "stop" });
  streamBehavior = null;
  keys = { go: "sk-go-test", zen: "sk-zen-test" };
});

test("a missing key is refused before any request", async () => {
  keys.go = "";
  const result = await handlers.get("process-opencode-reasoning")(
    { sender: sender(1) },
    "opencode-go",
    "hi",
    "glm-5.3",
    null,
    {}
  );
  assert.equal(result.success, false);
  assert.equal(result.code, "API_KEY_MISSING");
  assert.equal(generateCalls.length, 0);
  assert.equal(openAiConfigs.length, 0);
});

test("an unknown provider id is refused", async () => {
  const result = await handlers.get("process-opencode-reasoning")(
    { sender: sender(1) },
    "opencode",
    "hi",
    "glm-5.3",
    null,
    {}
  );
  assert.equal(result.success, false);
  assert.match(result.error, /Unsupported OpenCode provider/);
  assert.equal(generateCalls.length, 0);
});

test("Go cleanup sends the session header, Zen does not", async () => {
  await handlers.get("process-opencode-reasoning")(
    { sender: sender(1) },
    "opencode-go",
    "hi",
    "glm-5.3",
    null,
    { systemPrompt: "Clean this.", maxTokens: 100, supportsTemperature: true }
  );
  await handlers.get("process-opencode-reasoning")(
    { sender: sender(1) },
    "opencode-zen",
    "hi",
    "glm-5.3",
    null,
    { systemPrompt: "Clean this.", maxTokens: 100, supportsTemperature: true }
  );

  assert.equal(openAiConfigs[0][0], "chat");
  assert.equal(openAiConfigs[0][1].baseURL, "https://opencode.ai/inference/openai/v1");
  assert.match(openAiConfigs[0][1].headers["x-opencode-session"], /^[0-9a-f-]{36}$/i);
  assert.equal(openAiConfigs[1][1].baseURL, "https://opencode.ai/inference/openai/v1");
  assert.deepEqual(openAiConfigs[1][1].headers, {});
});

test("a cleanup passes the registry's temperature fact and the caller's timeout", async () => {
  let call;
  generateBehavior = async (options) => {
    call = options;
    return { text: "  cleaned  ", finishReason: "stop" };
  };
  const result = await handlers.get("process-opencode-reasoning")(
    { sender: sender(1) },
    "opencode-go",
    "raw",
    "glm-5.3",
    null,
    {
      systemPrompt: "Clean this.",
      maxTokens: 25000,
      temperature: 0.2,
      supportsTemperature: true,
      timeoutMs: 600000,
    }
  );

  assert.deepEqual(result, { success: true, text: "cleaned" });
  assert.equal(call.model.modelId, "glm-5.3");
  assert.equal(call.system, "Clean this.");
  assert.equal(call.prompt, "raw");
  assert.equal(call.maxOutputTokens, 25000);
  assert.equal(call.temperature, 0.2);
  assert.ok(call.abortSignal, "a deadline is set");
  assert.equal(call.maxRetries, 0);
});

test("a temperature-rejecting model gets no temperature", async () => {
  let call;
  generateBehavior = async (options) => {
    call = options;
    return { text: "cleaned", finishReason: "stop" };
  };
  await handlers.get("process-opencode-reasoning")(
    { sender: sender(1) },
    "opencode-go",
    "raw",
    "kimi-k3",
    null,
    { systemPrompt: "Clean this.", supportsTemperature: false }
  );
  assert.equal("temperature" in call, false);
});

test("a truncated or empty reply carries the cleanup message keys", async () => {
  generateBehavior = async () => ({ text: "half", finishReason: "length" });
  const truncated = await handlers.get("process-opencode-reasoning")(
    { sender: sender(1) },
    "opencode-go",
    "raw",
    "glm-5.3",
    null,
    { systemPrompt: "Clean this.", requireCompleteOutput: true }
  );
  assert.equal(truncated.success, false);
  assert.equal(truncated.messageKey, "hooks.audioRecording.errorDescriptions.cleanupTruncated");

  generateBehavior = async () => ({ text: "   ", finishReason: "stop" });
  const empty = await handlers.get("process-opencode-reasoning")(
    { sender: sender(1) },
    "opencode-go",
    "raw",
    "glm-5.3",
    null,
    { systemPrompt: "Clean this." }
  );
  assert.equal(empty.success, false);
  assert.equal(empty.messageKey, "hooks.audioRecording.errorDescriptions.cleanupEmptyReply");
});

test("streaming relays each part, then done, under the caller's session", async () => {
  let call;
  streamBehavior = ({ modelId, options }) => {
    call = { modelId, options };
    return {
      stream: streamOf([
        { type: "text-start", id: "t1" },
        { type: "text-delta", id: "t1", delta: "hi" },
        { type: "text-end", id: "t1" },
      ]),
    };
  };
  const event = { sender: sender(7) };
  const result = await handlers.get("opencode-stream-start")(event, {
    streamId: "stream-1",
    sessionId: "turn-session",
    provider: "opencode-go",
    modelId: "glm-5.3",
    options: { prompt: [{ role: "user", content: "hi" }] },
  });

  assert.deepEqual(result, { success: true });
  assert.equal(call.modelId, "glm-5.3");
  assert.equal(openAiConfigs[0][1].headers["x-opencode-session"], "turn-session");
  assert.deepEqual(
    event.sender.sent.map(({ payload }) => payload),
    [
      { streamId: "stream-1", part: { type: "text-start", id: "t1" } },
      { streamId: "stream-1", part: { type: "text-delta", id: "t1", delta: "hi" } },
      { streamId: "stream-1", part: { type: "text-end", id: "t1" } },
      { streamId: "stream-1", done: true },
    ]
  );
});

test("a one-shot routes each protocol to its client under the caller's session", async () => {
  const routes = [
    {
      protocol: "chat-completions",
      baseUrl: "https://opencode.ai/inference/openai/v1",
      modelId: "glm-5.3",
    },
    {
      protocol: "responses",
      baseUrl: "https://opencode.ai/inference/openai/v1",
      modelId: "gpt-5.6-luna",
    },
    {
      protocol: "messages",
      baseUrl: "https://opencode.ai/inference/anthropic/v1",
      modelId: "claude-haiku-5-5",
    },
    {
      protocol: "generate-content",
      baseUrl: "https://opencode.ai/inference/google/v1beta",
      modelId: "gemini-4-argon",
    },
  ];
  for (const { protocol, baseUrl, modelId } of routes) {
    const result = await handlers.get("process-opencode-reasoning")(
      { sender: sender(1) },
      "opencode-go",
      "hi",
      modelId,
      null,
      { systemPrompt: "Clean this.", protocol, baseUrl }
    );
    assert.equal(result.success, true, `${protocol} succeeds`);
  }

  assert.deepEqual(
    generateCalls.map((call) => call.model.kind),
    ["chat", "responses", "messages", "generate-content"]
  );
  assert.deepEqual(
    openAiConfigs.map(([constructor, config, modelId]) => [constructor, config.baseURL, modelId]),
    [
      ["chat", "https://opencode.ai/inference/openai/v1", "glm-5.3"],
      ["responses", "https://opencode.ai/inference/openai/v1", "gpt-5.6-luna"],
    ]
  );
  assert.equal(anthropicConfigs[0].baseURL, "https://opencode.ai/inference/anthropic/v1");
  assert.equal(googleConfigs[0].baseURL, "https://opencode.ai/inference/google/v1beta");
  // Go's session header rides on every protocol, not just Chat Completions.
  for (const config of [
    openAiConfigs[0][1],
    openAiConfigs[1][1],
    anthropicConfigs[0],
    googleConfigs[0],
  ]) {
    assert.match(config.headers["x-opencode-session"], /^[0-9a-f-]{36}$/i);
  }
  assert.equal(anthropicConfigs[0].authToken, "sk-go-test");
  assert.equal(googleConfigs[0].headers.Authorization, "Bearer sk-go-test");
});

test("a stream routes a non-chat protocol to its client under the turn's session", async () => {
  const kinds = [];
  streamBehavior = ({ kind }) => {
    kinds.push(kind);
    return { stream: streamOf([{ type: "text-delta", id: "t1", delta: "hi" }]) };
  };
  for (const [modelId, protocol, baseUrl] of [
    ["gpt-5.6-luna", "responses", "https://opencode.ai/inference/openai/v1"],
    ["claude-haiku-5-5", "messages", "https://opencode.ai/inference/anthropic/v1"],
    ["gemini-4-argon", "generate-content", "https://opencode.ai/inference/google/v1beta"],
  ]) {
    const event = { sender: sender(7) };
    const result = await handlers.get("opencode-stream-start")(event, {
      streamId: `stream-${modelId}`,
      sessionId: "turn-session",
      provider: "opencode-go",
      modelId,
      config: { protocol, baseUrl },
      options: { prompt: [{ role: "user", content: "hi" }] },
    });
    assert.deepEqual(result, { success: true }, `${protocol} streams`);
    assert.deepEqual(
      event.sender.sent.map(({ payload }) => payload),
      [
        { streamId: `stream-${modelId}`, part: { type: "text-delta", id: "t1", delta: "hi" } },
        { streamId: `stream-${modelId}`, done: true },
      ]
    );
  }

  assert.deepEqual(kinds, ["responses", "messages", "generate-content"]);
  assert.equal(openAiConfigs[0][1].headers["x-opencode-session"], "turn-session");
  assert.equal(anthropicConfigs[0].headers["x-opencode-session"], "turn-session");
  assert.equal(googleConfigs[0].headers["x-opencode-session"], "turn-session");
});

test("a renderer-supplied base URL outside opencode.ai is refused", async () => {
  const oneShot = await handlers.get("process-opencode-reasoning")(
    { sender: sender(1) },
    "opencode-go",
    "hi",
    "glm-5.3",
    null,
    {
      systemPrompt: "Clean this.",
      protocol: "chat-completions",
      baseUrl: "https://evil.example/v1",
    }
  );
  assert.equal(oneShot.success, false);
  assert.match(oneShot.error, /Refusing to send the OpenCode key/);

  const event = { sender: sender(7) };
  const streamed = await handlers.get("opencode-stream-start")(event, {
    streamId: "stream-evil",
    provider: "opencode-go",
    modelId: "glm-5.3",
    config: { protocol: "chat-completions", baseUrl: "https://evil.example/v1" },
    options: { prompt: [] },
  });
  assert.equal(streamed.success, false);
  assert.match(streamed.error, /Refusing to send the OpenCode key/);
  assert.equal(generateCalls.length, 0);
});

test("streaming a model failure reports it once and stops", async () => {
  streamBehavior = () => {
    throw Object.assign(new Error("no such model"), { statusCode: 404 });
  };
  const event = { sender: sender(8) };
  const result = await handlers.get("opencode-stream-start")(event, {
    streamId: "stream-2",
    provider: "opencode-zen",
    modelId: "missing-model",
    options: { prompt: [] },
  });

  assert.equal(result.success, false);
  assert.equal(event.sender.sent.length, 1);
  assert.equal(event.sender.sent[0].channel, "opencode-stream-part");
  assert.ok(event.sender.sent[0].payload.error, "the renderer hears why the stream failed");
});

test("a cancelled stream aborts the provider request", async () => {
  let signal;
  let started;
  const startedPromise = new Promise((resolve) => {
    started = resolve;
  });
  streamBehavior = ({ options }) => {
    signal = options.abortSignal;
    started();
    return {
      stream: new ReadableStream({
        start(controller) {
          signal.addEventListener("abort", () => controller.close());
        },
      }),
    };
  };
  const event = { sender: sender(9) };
  const running = handlers.get("opencode-stream-start")(event, {
    streamId: "stream-3",
    provider: "opencode-go",
    modelId: "glm-5.3",
    options: { prompt: [] },
  });
  await startedPromise;
  await handlers.get("opencode-stream-cancel")(event, "stream-3");
  await running;
  assert.equal(signal.aborted, true);
});

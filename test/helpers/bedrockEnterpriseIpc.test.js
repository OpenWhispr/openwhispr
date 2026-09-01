const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

const handlersModulePath = require.resolve("../../src/helpers/ipcHandlers");
const originalLoad = Module._load;
const handlers = new Map();
const generateCalls = [];
let generateBehavior = async () => ({ text: "hello", finishReason: "stop" });

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
      return { getEnterpriseAIModel: () => ({ provider: "bedrock-test-model" }) };
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
  const target = { sessionId: "test-session" };
  return new Proxy(target, {
    get: (value, property) => (property in value ? value[property] : anything()),
  });
}

function retryable503() {
  return Object.assign(new Error("Bedrock overloaded"), {
    name: "ServiceUnavailableException",
    statusCode: 503,
    responseHeaders: { "x-amzn-requestid": "aws-request-503" },
  });
}

test.before(() => {
  delete require.cache[handlersModulePath];
  const IPCHandlers = require(handlersModulePath);
  const Ctor = IPCHandlers.default || IPCHandlers;
  Ctor.prototype.setupHandlers.call(buildFakeThis());
  assert.ok(handlers.get("test-enterprise-connection"));
  assert.ok(handlers.get("process-enterprise-reasoning"));
});

test.after(() => {
  Module._load = originalLoad;
});

test.beforeEach(() => {
  generateCalls.length = 0;
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
    const result = await handlers.get("test-enterprise-connection")({ sender: {} }, "bedrock", {
      model: "anthropic.claude-haiku",
      bedrockRegion: "eu-west-1",
    });

    assert.deepEqual(result, { success: true });
    assert.equal(generateCalls.length, 2);
    assert.ok(generateCalls.every((call) => call.maxRetries === 0));
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
      { sender: {} },
      "raw dictation",
      "anthropic.claude-haiku",
      null,
      {
        provider: "bedrock",
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

test("Check connection returns AWS diagnostics without a dictation fallback status", async () => {
  generateBehavior = async () => {
    throw Object.assign(new Error("Bad signature"), {
      name: "UnrecognizedClientException",
      statusCode: 401,
      responseHeaders: { "x-amzn-requestid": "connection-request-id" },
    });
  };

  const result = await handlers.get("test-enterprise-connection")({ sender: {} }, "bedrock", {
    model: "anthropic.claude-haiku",
    bedrockRegion: "eu-west-1",
  });

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
    { sender: {} },
    "raw dictation",
    "anthropic.claude-haiku",
    null,
    { provider: "bedrock", bedrockRegion: "eu-west-1", systemPrompt: "Clean it" }
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

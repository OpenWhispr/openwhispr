const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

const factoryModulePath = require.resolve("../../src/helpers/opencodeLanguageModel");
const originalLoad = Module._load;

// Constructor calls observed per AI SDK package: [constructor, config, modelId].
const seen = { openai: [], anthropic: [], google: [] };

function loadFactory() {
  delete require.cache[factoryModulePath];
  delete require.cache[require.resolve("../../src/config/opencodeModelPolicy.js")];
  return require(factoryModulePath);
}

test.before(() => {
  Module._load = loadWithMocks;
});

test.after(() => {
  Module._load = originalLoad;
});

function loadWithMocks(request, parent, isMain) {
  if (parent?.filename === factoryModulePath) {
    if (request === "@ai-sdk/openai") {
      return {
        createOpenAI: (config) => ({
          chat: (modelId) => {
            seen.openai.push(["chat", config, modelId]);
            return { kind: "chat", modelId };
          },
          responses: (modelId) => {
            seen.openai.push(["responses", config, modelId]);
            return { kind: "responses", modelId };
          },
        }),
      };
    }
    if (request === "@ai-sdk/anthropic") {
      return {
        createAnthropic: (config) => (modelId) => {
          seen.anthropic.push(["messages", config, modelId]);
          return { kind: "messages", modelId };
        },
      };
    }
    if (request === "@ai-sdk/google") {
      return {
        createGoogleGenerativeAI: (config) => (modelId) => {
          seen.google.push(["generate-content", config, modelId]);
          return { kind: "generate-content", modelId };
        },
      };
    }
  }
  return originalLoad.call(this, request, parent, isMain);
}

const SESSION = { "x-opencode-session": "turn-1" };
const CHAT_BASE = "https://opencode.ai/inference/openai/v1";

test.beforeEach(() => {
  seen.openai.length = 0;
  seen.anthropic.length = 0;
  seen.google.length = 0;
});

test("a chat model keeps the OpenAI client on the inference base", () => {
  const { createOpencodeLanguageModel } = loadFactory();
  const model = createOpencodeLanguageModel({
    protocol: "chat-completions",
    baseUrl: CHAT_BASE,
    apiKey: "sk-test",
    modelId: "glm-5.3",
    sessionHeaders: SESSION,
    fetch: () => {},
  });

  assert.equal(model.kind, "chat");
  assert.equal(seen.openai.length, 1);
  const [constructor, config, modelId] = seen.openai[0];
  assert.equal(constructor, "chat");
  assert.equal(config.baseURL, CHAT_BASE);
  assert.equal(config.apiKey, "sk-test");
  assert.deepEqual(config.headers, SESSION);
  assert.equal(typeof config.fetch, "function");
  assert.equal(modelId, "glm-5.3");
});

test("a responses model uses the OpenAI responses client on the same base", () => {
  const { createOpencodeLanguageModel } = loadFactory();
  const model = createOpencodeLanguageModel({
    protocol: "responses",
    baseUrl: CHAT_BASE,
    apiKey: "sk-test",
    modelId: "gpt-5.6-luna",
    sessionHeaders: SESSION,
    fetch: () => {},
  });

  assert.equal(model.kind, "responses");
  assert.equal(seen.openai[0][0], "responses");
  assert.equal(seen.openai[0][1].baseURL, CHAT_BASE);
  assert.deepEqual(seen.openai[0][1].headers, SESSION);
});

test("a messages model uses the Anthropic client with a Bearer token", () => {
  const { createOpencodeLanguageModel } = loadFactory();
  const model = createOpencodeLanguageModel({
    protocol: "messages",
    baseUrl: "https://opencode.ai/inference/anthropic/v1",
    apiKey: "sk-test",
    modelId: "claude-haiku-5-5",
    sessionHeaders: SESSION,
    fetch: () => {},
  });

  assert.equal(model.kind, "messages");
  assert.equal(seen.anthropic.length, 1);
  const [, config, modelId] = seen.anthropic[0];
  // authToken (not apiKey) sends a pure Authorization: Bearer header with no
  // x-api-key, which is what the proxy authenticates on.
  assert.equal(config.authToken, "sk-test");
  assert.equal("apiKey" in config, false);
  assert.equal(config.baseURL, "https://opencode.ai/inference/anthropic/v1");
  assert.deepEqual(config.headers, SESSION);
  assert.equal(modelId, "claude-haiku-5-5");
});

test("a generate-content model uses the Google client with the key beside the session header", () => {
  const { createOpencodeLanguageModel } = loadFactory();
  const model = createOpencodeLanguageModel({
    protocol: "generate-content",
    baseUrl: "https://opencode.ai/inference/google/v1beta",
    apiKey: "sk-test",
    modelId: "gemini-4-argon",
    sessionHeaders: SESSION,
    fetch: () => {},
  });

  assert.equal(model.kind, "generate-content");
  assert.equal(seen.google.length, 1);
  const [, config, modelId] = seen.google[0];
  assert.equal(config.baseURL, "https://opencode.ai/inference/google/v1beta");
  assert.equal(config.headers.Authorization, "Bearer sk-test");
  assert.equal(config.headers["x-opencode-session"], "turn-1");
  assert.equal(modelId, "gemini-4-argon");
});

test("a missing route resolves to Chat Completions on the shared inference base", () => {
  const { createOpencodeLanguageModel } = loadFactory();
  const model = createOpencodeLanguageModel({
    apiKey: "sk-test",
    modelId: "glm-5.3",
    fetch: () => {},
  });

  assert.equal(model.kind, "chat");
  assert.equal(seen.openai[0][1].baseURL, CHAT_BASE);
});

test("an unknown protocol resolves to Chat Completions rather than failing", () => {
  const { createOpencodeLanguageModel } = loadFactory();
  const model = createOpencodeLanguageModel({
    protocol: "telepathy-v2",
    apiKey: "sk-test",
    modelId: "glm-5.3",
    fetch: () => {},
  });

  assert.equal(model.kind, "chat");
  assert.equal(seen.openai[0][1].baseURL, CHAT_BASE);
});

test("a base URL outside opencode.ai inference is refused before any request", () => {
  const { createOpencodeLanguageModel } = loadFactory();
  for (const baseUrl of [
    "https://opencode.ai/zen/go/v1",
    "https://evil.example/v1",
    "http://opencode.ai/inference/openai/v1",
  ]) {
    assert.throws(
      () =>
        createOpencodeLanguageModel({
          protocol: "chat-completions",
          baseUrl,
          apiKey: "sk-test",
          modelId: "glm-5.3",
          fetch: () => {},
        }),
      /Refusing to send the OpenCode key/,
      `refuses ${baseUrl}`
    );
  }
  assert.equal(seen.openai.length, 0);
  assert.equal(seen.anthropic.length, 0);
  assert.equal(seen.google.length, 0);
});

test("an empty base URL reads as no route and takes the shared inference base", () => {
  const { createOpencodeLanguageModel } = loadFactory();
  const model = createOpencodeLanguageModel({
    protocol: "chat-completions",
    baseUrl: "",
    apiKey: "sk-test",
    modelId: "glm-5.3",
    fetch: () => {},
  });

  assert.equal(model.kind, "chat");
  assert.equal(seen.openai[0][1].baseURL, CHAT_BASE);
});

test("a missing model id is refused", () => {
  const { createOpencodeLanguageModel } = loadFactory();
  assert.throws(
    () =>
      createOpencodeLanguageModel({
        protocol: "chat-completions",
        baseUrl: CHAT_BASE,
        apiKey: "sk-test",
        fetch: () => {},
      }),
    /No model specified/
  );
});

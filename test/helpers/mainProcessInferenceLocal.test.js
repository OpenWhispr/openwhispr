const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

// The pipeline runs in the main process and resolves its provider from
// NOTE_FORMATTING_PROVIDER. Until now MainProcessInference only knew openai,
// anthropic and gemini — so a local-model user got "Unsupported inference
// provider" and no title and no notes, including via the app's own
// auto-configure path which sets provider = "local".

let localCalls = [];
const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === "../services/localReasoningBridge") {
    return {
      default: {
        processText: async (text, modelId, config) => {
          localCalls.push({ text, modelId, config });
          return "Local Model Title";
        },
      },
    };
  }
  if (request === "./debugLogger") {
    return { info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, log: () => {} };
  }
  return originalLoad.call(this, request, parent, isMain);
};

const { MainProcessInference } = require("../../src/helpers/mainProcessInference.js");

function makeInference() {
  localCalls = [];
  return new MainProcessInference(global.fetch, {
    getOpenAIKey: () => "",
    getAnthropicKey: () => "",
    getGeminiKey: () => "",
  });
}

test("the local provider is supported", async () => {
  const inference = makeInference();

  const result = await inference.processText("transcript text", {
    provider: "local",
    model: "gemma-4-e4b-it-q4_k_m",
    systemPrompt: "Generate a title",
  });

  assert.equal(result, "Local Model Title");
  assert.equal(localCalls.length, 1, "must route to the local reasoning bridge");
  assert.equal(localCalls[0].modelId, "gemma-4-e4b-it-q4_k_m");
  assert.equal(localCalls[0].config.systemPrompt, "Generate a title");
});

test("a model family written into the provider field still resolves locally", async () => {
  // Real config seen in the wild: NOTE_FORMATTING_PROVIDER=gemma, which is a
  // model family rather than a provider. It must not hard-fail the pipeline.
  const inference = makeInference();

  const result = await inference.processText("transcript text", {
    provider: "gemma",
    model: "gemma-4-e4b-it-q4_k_m",
    systemPrompt: "Generate a title",
  });

  assert.equal(result, "Local Model Title");
  assert.equal(localCalls.length, 1);
});

test("an unknown provider names itself and the supported set", async () => {
  const inference = makeInference();

  await assert.rejects(
    () =>
      inference.processText("text", {
        provider: "wat",
        model: "some-model",
        systemPrompt: "x",
      }),
    (error) => {
      assert.match(error.message, /wat/, "the offending value must appear");
      assert.match(error.message, /local/, "the supported providers must be listed");
      assert.match(error.message, /openai/);
      return true;
    }
  );
});

test("the supported provider list includes local", () => {
  assert.ok(MainProcessInference.SUPPORTED_PROVIDERS.includes("local"));
  assert.ok(MainProcessInference.SUPPORTED_PROVIDERS.includes("openai"));
  assert.ok(MainProcessInference.SUPPORTED_PROVIDERS.includes("anthropic"));
  assert.ok(MainProcessInference.SUPPORTED_PROVIDERS.includes("gemini"));
});

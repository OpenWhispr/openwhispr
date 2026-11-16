const test = require("node:test");
const assert = require("node:assert/strict");

const modelRegistryData = require("../../src/models/modelRegistryData.json");

const load = () => import("../../src/models/ModelRegistry.ts");

// OpenRouter ids carry a vendor prefix the registry stores without. The
// screen-context gate reads supportsVision off the registry entry, so a miss
// here drops every screenshot for an OpenRouter agent (#2203).
test("openrouter vendor-prefixed ids resolve to the upstream registry model", async () => {
  const { getCloudModel } = await load();

  assert.equal(getCloudModel("google/gemini-3.5-flash-lite", "openrouter")?.supportsVision, true);
  assert.equal(getCloudModel("google/gemini-3.5-flash-lite"), undefined);
  assert.equal(getCloudModel("google/gemini-3.5-flash-lite", "custom"), undefined);
  // OpenRouter writes Claude versions with dots; the registry with dashes.
  assert.equal(getCloudModel("anthropic/claude-haiku-5.5", "openrouter")?.id, "claude-haiku-5-5");
});

test("an exact registry id wins before the prefix is stripped", async () => {
  const { getCloudModel } = await load();
  // Groq lists gpt-oss under its OpenRouter-style id.
  const groqGptOss = modelRegistryData.cloudProviders
    .find((provider) => provider.id === "groq")
    .models.find((model) => model.id === "openai/gpt-oss-120b");

  assert.deepEqual(getCloudModel("openai/gpt-oss-120b", "openrouter"), groqGptOss);
});

// The vision list promises a screenshot reaches each model as the assistant's main
// model too, which the gate only allows for a registry entry with vision.
test("every OpenRouter vision model resolves to a registry model with vision", async () => {
  const { getCloudModel } = await load();
  const { OPENROUTER_VISION_MODELS } = await import("../../src/utils/openRouterModels.ts");

  for (const id of OPENROUTER_VISION_MODELS) {
    assert.equal(getCloudModel(id, "openrouter")?.supportsVision, true, id);
  }
});

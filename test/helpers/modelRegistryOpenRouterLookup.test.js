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
});

test("an exact registry id wins before the prefix is stripped", async () => {
  const { getCloudModel } = await load();
  // Groq lists gpt-oss under its OpenRouter-style id.
  const groqGptOss = modelRegistryData.cloudProviders
    .find((provider) => provider.id === "groq")
    .models.find((model) => model.id === "openai/gpt-oss-120b");

  assert.deepEqual(getCloudModel("openai/gpt-oss-120b", "openrouter"), groqGptOss);
});

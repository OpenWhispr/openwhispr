const test = require("node:test");
const assert = require("node:assert/strict");

const modelData = require("../../src/models/modelRegistryData.json");

// Exact expected entries per ai.google.dev/gemini-api/docs/models.
// gemini-3.1-flash-lite has no thinking support, so it must never carry
// supportsThinking: the Gemini provider would send thinkingConfig and get a 400.
const EXPECTED = {
  "gemini-3.5-flash-lite": {
    name: "Gemini 3.5 Flash Lite",
    descriptionKey: "models.descriptions.cloud.gemini_gemini_3_5_flash_lite",
    supportsThinking: true,
    supportsVision: true,
  },
  "gemini-3.1-flash-lite": {
    name: "Gemini 3.1 Flash Lite",
    descriptionKey: "models.descriptions.cloud.gemini_gemini_3_1_flash_lite",
    supportsThinking: undefined,
    supportsVision: true,
  },
};

function geminiModels() {
  const provider = modelData.cloudProviders.find((p) => p.id === "gemini");
  assert.ok(provider, "gemini provider missing from registry");
  return provider.models;
}

test("the Flash Lite entries carry the exact ids, names, and capability flags", () => {
  const byId = new Map(geminiModels().map((m) => [m.id, m]));

  for (const [id, expected] of Object.entries(EXPECTED)) {
    const model = byId.get(id);
    assert.ok(model, `missing Gemini entry ${id}`);
    assert.equal(model.name, expected.name, `${id} name`);
    assert.equal(model.descriptionKey, expected.descriptionKey, `${id} descriptionKey`);
    assert.equal(model.supportsThinking, expected.supportsThinking, `${id} supportsThinking`);
    assert.equal(model.supportsVision, expected.supportsVision, `${id} supportsVision`);
  }
});

test("gemini-2.5-flash-lite stays in the registry for existing API keys", () => {
  const model = geminiModels().find((m) => m.id === "gemini-2.5-flash-lite");
  assert.ok(model, "gemini-2.5-flash-lite was removed; existing keys still resolve it");
});

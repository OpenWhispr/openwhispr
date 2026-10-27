const test = require("node:test");
const assert = require("node:assert/strict");

const modelData = require("../../src/models/modelRegistryData.json");

// Exact expected entries per ai.google.dev/gemini-api/docs/models.
// gemini-3.1-flash-lite has no thinking support, so it must never carry
// supportsThinking: the Gemini provider would send thinkingConfig and get a 400.
const EXPECTED = {
  "gemini-3.8-flash": {
    name: "Gemini 3.8 Flash",
    descriptionKey: "models.descriptions.cloud.gemini_gemini_3_8_flash",
    supportsThinking: true,
    supportsVision: true,
  },
  "gemini-4-argon": {
    name: "Gemini 4 Argon",
    descriptionKey: "models.descriptions.cloud.gemini_gemini_4_argon",
    supportsThinking: true,
    supportsVision: true,
  },
  "gemini-3.6-flash": {
    name: "Gemini 3.6 Flash",
    descriptionKey: "models.descriptions.cloud.gemini_gemini_3_6_flash",
    supportsThinking: true,
    supportsVision: true,
  },
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

test("the current Gemini entries carry the exact ids, names, and capability flags", () => {
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

test("gemini-3.8-flash is the Gemini default (first entry)", () => {
  assert.equal(geminiModels()[0].id, "gemini-3.8-flash");
});

test("superseded Gemini entries are no longer offered", () => {
  const ids = new Set(geminiModels().map((m) => m.id));
  assert.equal(ids.has("gemini-3.5-flash"), false);
  assert.equal(ids.has("gemini-3-flash-preview"), false);
});

test("gemini-2.5-flash-lite stays in the registry for existing API keys", () => {
  const model = geminiModels().find((m) => m.id === "gemini-2.5-flash-lite");
  assert.ok(model, "gemini-2.5-flash-lite was removed; existing keys still resolve it");
});

test("Vertex offers the current Gemini models instead of the retiring 2.5 pair", () => {
  const vertex = modelData.enterpriseProviders.find((p) => p.id === "vertex");
  assert.ok(vertex, "vertex provider missing from registry");
  assert.deepEqual(
    vertex.models.map((m) => m.id),
    ["gemini-3.8-flash", "gemini-4-argon"]
  );
});

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const modelData = require("../../src/models/modelRegistryData.json");

const LOCALES_DIR = path.join(__dirname, "../../src/locales");

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

test("every Gemini descriptionKey resolves in every locale", () => {
  const languages = fs
    .readdirSync(LOCALES_DIR)
    .filter((entry) => fs.statSync(path.join(LOCALES_DIR, entry)).isDirectory());
  assert.ok(languages.length > 0, "no locale directories found");

  for (const lang of languages) {
    const translation = JSON.parse(
      fs.readFileSync(path.join(LOCALES_DIR, lang, "translation.json"), "utf8")
    );
    for (const model of geminiModels()) {
      const value = model.descriptionKey
        .split(".")
        .reduce((node, part) => (node ? node[part] : undefined), translation);
      assert.equal(typeof value, "string", `${lang} missing ${model.descriptionKey}`);
      assert.ok(value.length > 0, `${lang} has empty ${model.descriptionKey}`);
    }
  }
});

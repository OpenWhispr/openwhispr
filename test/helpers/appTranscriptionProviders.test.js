const test = require("node:test");
const assert = require("node:assert/strict");
const { acceptCatalog } = require("../../src/models/registrySchema.cjs");
const {
  withAppTranscriptionProviders,
  isUploadOnlyTranscriptionModel,
} = require("../../src/models/appTranscriptionProviders.js");
const vendored = require("../../src/models/modelRegistryData.json");

const openRouter = (catalog) => catalog.transcriptionProviders.find((p) => p.id === "openrouter");

// main.js hands the loader this bundle, and the loader keeps only providers the bundle has.
test("OpenRouter survives a live catalog that does not list it", () => {
  assert.equal(openRouter(vendored), undefined, "sync the catalog, then drop the app's entry");
  const bundled = withAppTranscriptionProviders(vendored);
  const applied = acceptCatalog(vendored, bundled, "1.11.1");

  assert.deepEqual(
    openRouter(applied).models.map((model) => model.id),
    openRouter(bundled).models.map((model) => model.id)
  );
  assert.equal(openRouter(applied).baseUrl, "https://openrouter.ai/api/v1");
  assert.equal(openRouter(applied).defaultModel, openRouter(bundled).defaultModel);
});

test("a catalog that lists a provider keeps its own entry", () => {
  const listed = {
    ...vendored,
    transcriptionProviders: [
      ...vendored.transcriptionProviders,
      { id: "openrouter", name: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1", models: [] },
    ],
  };
  const merged = withAppTranscriptionProviders(listed);
  assert.equal(merged.transcriptionProviders.filter((p) => p.id === "openrouter").length, 1);
  assert.deepEqual(openRouter(merged).models, []);
});

test("upload-only is known by id, since the catalog reader drops unknown fields", () => {
  assert.equal(isUploadOnlyTranscriptionModel("openrouter", "deepgram/nova-3"), true);
  assert.equal(isUploadOnlyTranscriptionModel("openrouter", "openai/gpt-transcribe"), false);
  assert.equal(isUploadOnlyTranscriptionModel("deepgram", "nova-3"), false);
  assert.equal(isUploadOnlyTranscriptionModel("constructor", "deepgram/nova-3"), false);
});

const test = require("node:test");
const assert = require("node:assert/strict");
const { acceptCatalog } = require("../../src/models/registrySchema.cjs");
const { withAppTranscriptionProviders } = require("../../src/models/appTranscriptionProviders.js");
const { bundledRegistryData: bundled } = require("../../src/models/registryData.js");
const vendored = require("../../src/models/modelRegistryData.json");

const openRouter = (catalog) => catalog.transcriptionProviders.find((p) => p.id === "openrouter");

// main.js hands the loader this bundle, and the loader keeps only providers the bundle has.
test("OpenRouter survives a live catalog that does not list it", () => {
  assert.equal(openRouter(vendored), undefined, "sync the catalog, then drop the app's entry");
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

test("ElevenLabs survives a live catalog that does not list it", () => {
  const elevenLabs = (catalog) => catalog.transcriptionProviders.find((p) => p.id === "elevenlabs");
  assert.equal(elevenLabs(vendored), undefined, "sync the catalog, then drop the app's entry");
  const applied = acceptCatalog(vendored, bundled, "1.11.1");

  assert.deepEqual(
    elevenLabs(applied).models.map((model) => model.id),
    ["scribe_v2", "scribe_v2_realtime"]
  );
  assert.equal(elevenLabs(applied).defaultModel, "scribe_v2");
  assert.equal(elevenLabs(applied).batchModel, "scribe_v2");
  const realtime = elevenLabs(applied).models.find((model) => model.id === "scribe_v2_realtime");
  assert.equal(realtime.streaming, true);
  assert.equal(realtime.noteRecordingOnly, true, "the realtime model stays out of batch pickers");
});

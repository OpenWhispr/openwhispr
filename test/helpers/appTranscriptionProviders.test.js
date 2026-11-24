const test = require("node:test");
const assert = require("node:assert/strict");
const { acceptCatalog } = require("../../src/models/registrySchema.cjs");
const {
  withAppTranscriptionProviders,
  isNoteRecordingOnlyTranscriptionModel,
} = require("../../src/models/appTranscriptionProviders.js");
const { bundledRegistryData: bundled } = require("../../src/models/registryData.js");
const vendored = require("../../src/models/modelRegistryData.json");

const openRouter = (catalog) => catalog.transcriptionProviders.find((p) => p.id === "openrouter");
const elevenLabs = (catalog) => catalog.transcriptionProviders.find((p) => p.id === "elevenlabs");

// main.js hands the loader this bundle, and the loader keeps only providers the bundle has.
// Publications made before model-registry/ listed OpenRouter don't have it.
test("OpenRouter survives a live catalog that does not list it", () => {
  const unlisted = {
    ...vendored,
    transcriptionProviders: vendored.transcriptionProviders.filter((p) => p.id !== "openrouter"),
  };
  const applied = acceptCatalog(unlisted, bundled, "1.12.1");

  assert.deepEqual(
    openRouter(applied).models.map((model) => model.id),
    openRouter(vendored).models.map((model) => model.id)
  );
  assert.equal(openRouter(applied).baseUrl, "https://openrouter.ai/api/v1");
  assert.equal(openRouter(applied).defaultModel, openRouter(vendored).defaultModel);
});

test("a catalog that lists a provider keeps its own entry", () => {
  const listed = {
    ...vendored,
    transcriptionProviders: [
      ...vendored.transcriptionProviders,
      { id: "elevenlabs", name: "ElevenLabs", baseUrl: "https://api.elevenlabs.io/v1", models: [] },
    ],
  };
  const merged = withAppTranscriptionProviders(listed);
  assert.equal(merged.transcriptionProviders.filter((p) => p.id === "elevenlabs").length, 1);
  assert.deepEqual(elevenLabs(merged).models, []);
});

test("ElevenLabs survives a live catalog that does not list it", () => {
  assert.equal(elevenLabs(vendored), undefined, "sync the catalog, then drop the app's entry");
  const applied = acceptCatalog(vendored, bundled, "1.11.1");

  assert.deepEqual(
    elevenLabs(applied).models.map((model) => model.id),
    ["scribe_v3", "scribe_v2", "scribe_v3_live"]
  );
  assert.equal(elevenLabs(applied).defaultModel, "scribe_v3");
  assert.equal(elevenLabs(applied).batchModel, "scribe_v3");
  const realtime = elevenLabs(applied).models.find((model) => model.id === "scribe_v3_live");
  assert.equal(realtime.streaming, true);
});

test("the Note Recording-only rule holds when a publication lists the model", () => {
  // A publication can carry no such field, so its copy of the model arrives without one.
  const published = {
    ...vendored,
    transcriptionProviders: [
      ...vendored.transcriptionProviders,
      {
        id: "elevenlabs",
        name: "ElevenLabs",
        baseUrl: "https://api.elevenlabs.io/v1",
        defaultModel: "scribe_v3",
        batchModel: "scribe_v3",
        models: [
          { id: "scribe_v3", name: "Scribe v3", description: "Batch" },
          { id: "scribe_v3_live", name: "Scribe v3 Live", description: "Live", streaming: true },
        ],
      },
    ],
  };
  const applied = acceptCatalog(published, bundled, "1.11.1");
  const live = applied.transcriptionProviders
    .find((provider) => provider.id === "elevenlabs")
    .models.find((model) => model.id === "scribe_v3_live");

  assert.deepEqual(Object.keys(live).sort(), ["description", "id", "name", "streaming"]);
  assert.equal(isNoteRecordingOnlyTranscriptionModel("elevenlabs", live.id), true);
  assert.equal(isNoteRecordingOnlyTranscriptionModel("elevenlabs", "scribe_v3"), false);
  assert.equal(isNoteRecordingOnlyTranscriptionModel("gemini", "scribe_v3_live"), false);
});

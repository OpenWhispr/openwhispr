const test = require("node:test");
const assert = require("node:assert/strict");

// Settings once wrote a local model *family* ("gemma", "qwen", ...) into the
// provider field, which then reached .env as NOTE_FORMATTING_PROVIDER=gemma.
// The provider for every locally-served family is "local".
const load = () => import("../../src/stores/migrateLocalProviderField.ts");

function createStorage(initial = {}) {
  const data = { ...initial };
  return {
    data,
    getItem: (key) => (key in data ? data[key] : null),
    setItem: (key, value) => {
      data[key] = String(value);
    },
  };
}

const LLM_PROVIDER_KEYS = [
  "cleanupProvider",
  "noteFormattingProvider",
  "dictationAgentProvider",
  "chatAgentProvider",
];

test("the migration covers exactly the registry's local families", async () => {
  const { LOCAL_MODEL_FAMILY_IDS } = await load();
  const registry = require("../../src/models/modelRegistryData.json");
  assert.deepEqual(
    [...LOCAL_MODEL_FAMILY_IDS].sort(),
    registry.localProviders.map((p) => p.id).sort()
  );
});

test("every family id in every LLM provider key becomes local", async () => {
  const { migrateLocalProviderField, LOCAL_MODEL_FAMILY_IDS } = await load();

  for (const family of LOCAL_MODEL_FAMILY_IDS) {
    for (const key of LLM_PROVIDER_KEYS) {
      const storage = createStorage({ [key]: family });
      migrateLocalProviderField(storage);
      assert.equal(storage.data[key], "local", `${key}=${family} should migrate to "local"`);
    }
  }
});

test("a real provider id is left alone", async () => {
  const { migrateLocalProviderField } = await load();
  const storage = createStorage({
    cleanupProvider: "openai",
    noteFormattingProvider: "local",
    dictationAgentProvider: "anthropic",
    chatAgentProvider: "groq",
  });

  migrateLocalProviderField(storage);

  assert.equal(storage.data.cleanupProvider, "openai");
  assert.equal(storage.data.noteFormattingProvider, "local");
  assert.equal(storage.data.dictationAgentProvider, "anthropic");
  assert.equal(storage.data.chatAgentProvider, "groq");
});

// "mistral" is a local model family AND a legitimate cloud transcription
// provider, so the migration must be keyed on the four LLM provider keys.
test("a transcription provider key holding mistral is untouched", async () => {
  const { migrateLocalProviderField } = await load();
  const storage = createStorage({
    cloudTranscriptionProvider: "mistral",
    meetingCloudTranscriptionProvider: "mistral",
    uploadCloudTranscriptionProvider: "mistral",
    localTranscriptionProvider: "mistral",
    cleanupProvider: "mistral",
  });

  migrateLocalProviderField(storage);

  assert.equal(storage.data.cloudTranscriptionProvider, "mistral");
  assert.equal(storage.data.meetingCloudTranscriptionProvider, "mistral");
  assert.equal(storage.data.uploadCloudTranscriptionProvider, "mistral");
  assert.equal(storage.data.localTranscriptionProvider, "mistral");
  assert.equal(storage.data.cleanupProvider, "local", "only the LLM key migrates");
});

test("the sentinel makes the migration idempotent", async () => {
  const { migrateLocalProviderField } = await load();
  const storage = createStorage({ cleanupProvider: "gemma" });

  migrateLocalProviderField(storage);
  assert.equal(storage.data.cleanupProvider, "local");

  // A later deliberate choice must not be rewritten by a second run.
  storage.setItem("cleanupProvider", "gemma");
  migrateLocalProviderField(storage);
  assert.equal(storage.data.cleanupProvider, "gemma");
});
